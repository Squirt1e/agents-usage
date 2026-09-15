/**
 * The settings window's content: a left column of sections and one scrolling pane.
 *
 * ## Why this is one component and not two screens
 *
 * The window is a fixed 560x380 with a system title bar, so the split is fixed too:
 * the nav never scrolls away and the pane is the only scrolling area. Both host
 * paths render *this* component — the Tauri host loads it as its own document
 * (`settings.html`), and a plain browser mounts it as a sheet over the panel
 * document — so the sections, their order and their wording cannot drift between
 * the two.
 *
 * ## Sections, and why the order is what it is
 *
 * 平台管理 first: choosing which platforms the overview shows, and in which order,
 * is the setting users reach for most. 外观 second (it applies to both windows).
 * Then one section per platform, each carrying that platform's own connection forms
 * and its peak-schedule form. A platform's section is the *only* place its
 * credentials are edited, and only one section is ever mounted — the invariant the
 * specs pin as "one platform at a time" survives the move out of the panel.
 *
 * ## Section identity is also the pane's React key
 *
 * The key is what replays the pane's entrance animation and what re-attaches every
 * form's own state, so a section can never inherit the previous section's in-flight
 * write or its feedback line.
 *
 * ## Busy state belongs to the section, not to this component
 *
 * Each half owns its own in-flight bookkeeping (`AppSettings` for 平台管理 / 外观,
 * `ProviderSettings` for a platform), which is what keeps a write in one section
 * from dimming a control in another — the rule the specs pin as "a switch is only
 * disabled by its own write".
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ProviderId } from '../shared/contracts';
import {
  type CredentialStatus,
  type CredentialTarget,
  type DesktopProviderState,
  type PanelSettings,
  type PanelSettingsPatch,
  type PanelSnapshot
} from '../shared/desktop-contract';
import { AppSettings } from './AppSettings';
import { ProviderSettings } from './ProviderSettings';
import { providerView } from './metrics';

/** The sections the settings window can show, in nav order. */
export const SETTINGS_SECTIONS = ['platforms', 'appearance', 'codex', 'glm', 'deepseek'] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Where a section request is allowed to land: anything else falls back to 平台管理. */
export function parseSettingsSection(raw: unknown): SettingsSection {
  return SETTINGS_SECTIONS.includes(raw as SettingsSection) ? (raw as SettingsSection) : 'platforms';
}

/** The badge a nav row shows: the platform's monogram, or a glyph for a global section. */
const SECTION_BADGES: Record<SettingsSection, string> = {
  platforms: '▦',
  appearance: '◐',
  codex: 'CX',
  glm: 'GL',
  deepseek: 'DS'
};

const PROVIDER_SECTIONS = ['codex', 'glm', 'deepseek'] as const;

export const SECTION_TITLES: Record<SettingsSection, string> = {
  platforms: '平台管理',
  appearance: '外观',
  codex: 'Codex',
  glm: 'GLM',
  deepseek: 'DeepSeek'
};

const SECTION_NOTES: Record<SettingsSection, string> = {
  platforms: '选择总览展示哪些平台、以什么顺序展示。隐藏只影响显示，账号配置与采集都保留。',
  appearance: '主题与额度数值的显示方式，两个窗口共用同一份偏好。',
  codex: 'Codex 使用本机已有登录，这里只调整采集方式。',
  glm: 'Coding Plan 与实验钱包连接各自独立，分别保存凭据。',
  deepseek: '钱包与网页用量连接各自独立，网页用量需要单独粘贴 Token。'
};

export interface SettingsPanelProps {
  section: SettingsSection;
  onSelectSection(section: SettingsSection): void;
  settings: PanelSettings;
  /**
   * The snapshot a platform section reads its connection state from. The panel
   * passes the whole snapshot rather than a per-provider projection: the settings
   * window subscribes to snapshots itself, and `providerView` is the one place that
   * decides how the entries for a platform become a card-free view.
   */
  snapshot: PanelSnapshot | undefined;
  /** Platforms with a visibility write in flight; only their own switch dims. */
  togglingVisibility: ReadonlySet<ProviderId>;
  onToggleVisibility(provider: ProviderId, visible: boolean): void;
  onReorder(order: ProviderId[]): void;
  onThemeChange(theme: PanelSettings['theme']): Promise<void>;
  onQuotaValueModeChange(mode: PanelSettings['quotaValueMode']): Promise<void>;
  onUpdateSettings(patch: PanelSettingsPatch): Promise<void>;
  onValidateCredential(target: CredentialTarget, secret: string): Promise<CredentialStatus>;
  onDeleteCredential(target: CredentialTarget): Promise<void>;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const { section, onSelectSection } = props;
  const navRef = useRef<HTMLElement | null>(null);

  /**
   * The platform manager's per-platform connection state.
   *
   * The first entry wins, which is what the overview's cards do through
   * `providerView`: a platform can report several connections (a plan and a wallet),
   * and the row's status word belongs to the platform, not to one connection.
   */
  const states = useMemo(() => {
    const entries: Partial<Record<ProviderId, DesktopProviderState | undefined>> = {};
    for (const provider of PROVIDER_SECTIONS) {
      entries[provider] = (props.snapshot?.providers ?? []).find((state) => state.provider === provider);
    }
    return entries;
  }, [props.snapshot]);

  /** The pane's own busy bookkeeping for a platform section's writes: a count, so
   * two overlapping writes (a switch and a region) do not clear each other early. */
  const [pending, setPending] = useState(0);
  const updateSettings = useCallback(
    async (patch: PanelSettingsPatch) => {
      setPending((current) => current + 1);
      try {
        await props.onUpdateSettings(patch);
      } finally {
        setPending((current) => current - 1);
      }
    },
    [props]
  );

  /**
   * Arrow keys move between sections, as on the platform manager's rows: a column
   * of mutually exclusive choices is one control, not a list of separate buttons.
   * Home/End jump to the ends, the standard pairing for a tablist.
   */
  const onNavKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const index = SETTINGS_SECTIONS.indexOf(section);
      let next: SettingsSection | undefined;
      if (event.key === 'ArrowDown') next = SETTINGS_SECTIONS[(index + 1) % SETTINGS_SECTIONS.length];
      else if (event.key === 'ArrowUp')
        next = SETTINGS_SECTIONS[(index - 1 + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length];
      else if (event.key === 'Home') next = SETTINGS_SECTIONS[0];
      else if (event.key === 'End') next = SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1];
      if (!next || next === section) return;
      event.preventDefault();
      onSelectSection(next);
      // Roving focus: the newly current row takes focus, so the next arrow key
      // continues from where the reader is rather than from where they started.
      navRef.current?.querySelector<HTMLButtonElement>(`[data-section="${next}"]`)?.focus();
    },
    [section, onSelectSection]
  );

  const navRow = (id: SettingsSection) => (
    <button
      key={id}
      type="button"
      role="tab"
      data-section={id}
      aria-selected={section === id}
      tabIndex={section === id ? 0 : -1}
      className={`settings-nav-item${section === id ? ' is-active' : ''}`}
      onClick={() => onSelectSection(id)}
    >
      <span className="settings-nav-badge" aria-hidden="true">
        {SECTION_BADGES[id]}
      </span>
      <span className="settings-nav-label">{SECTION_TITLES[id]}</span>
    </button>
  );

  return (
    <div className="settings-window" data-testid="settings-window">
      <nav
        className="settings-nav"
        ref={navRef}
        role="tablist"
        aria-label="设置分类"
        aria-orientation="vertical"
        onKeyDown={onNavKeyDown}
      >
        <div className="settings-nav-group">面板</div>
        {navRow('platforms')}
        {navRow('appearance')}
        <div className="settings-nav-group">平台配置</div>
        {PROVIDER_SECTIONS.map((provider) => navRow(provider))}
      </nav>
      <div className="settings-content">
        <div className="settings-pane" key={section} role="tabpanel" data-testid={`settings-pane-${section}`}>
          <h2 className="settings-pane-title">{SECTION_TITLES[section]}</h2>
          <p className="settings-pane-note">{SECTION_NOTES[section]}</p>
          {section === 'platforms' || section === 'appearance' ? (
            <AppSettings
              part={section}
              settings={props.settings}
              states={states}
              busy={pending > 0}
              togglingVisibility={props.togglingVisibility}
              onToggleVisibility={props.onToggleVisibility}
              onReorder={props.onReorder}
              onThemeChange={props.onThemeChange}
              onQuotaValueModeChange={props.onQuotaValueModeChange}
            />
          ) : (
            <ProviderSettings
              provider={section}
              view={providerView(props.snapshot, section)}
              settings={props.settings}
              onUpdateSettings={updateSettings}
              onValidateCredential={props.onValidateCredential}
              onDeleteCredential={props.onDeleteCredential}
            />
          )}
        </div>
      </div>
    </div>
  );
}
