// @vitest-environment jsdom
// The motion guard for the desktop windows. AGENTS.md makes "every switch travels"
// a rule; this file is what keeps that rule enforceable instead of aspirational.
// jsdom computes no animations, so the stylesheets are read as text and held to
// four things:
//
//   1. every registered switch point declares the motion it needs;
//   2. every duration stays inside the panel's budget, apart from loops;
//   3. nothing silences motion outside `prefers-reduced-motion`, and no rule
//      reaches for `transition: all`;
//   4. the reduced-motion blanket covers all of it, and the sheet stays inside the
//      host's own timing for hiding the window.
//
// Both documents count. The panel (`panel.css`) and the settings window
// (`settings.css`) are separate sheets for separate host windows, but a switch is a
// switch wherever it lives, so the checks run over the pair: a switch registered
// below may be declared in either file, and the duration, silence and blanket
// sweeps walk both.
//
// Add a switch -> add it to the registry below (AGENTS.md §1.5). A switch that is
// deliberately instant needs an entry in EXCEPTIONS with a reason: no reason, no
// exception. The window-height switch is animated in TypeScript, so its preference
// behaviour is pinned in tests/panel-height-hook.test.tsx and only its budget is
// checked here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PANEL_HEIGHT_ANIMATION_MS } from '../../src/desktop/panel/panel-height';

/** The sheets the guard reads, in the order the documents load them. */
const SHEET_FILES = ['src/desktop/panel.css', 'src/desktop/settings.css'];

const CSS = readFileSync('src/desktop/panel.css', 'utf8');
/** Everything the two sheets declare, for the "who owns this switch" lookups. */
const ALL_CSS = SHEET_FILES.map((file) => readFileSync(file, 'utf8')).join('\n');
/** Comments go first: a rule that is commented out must not satisfy the guard. */
const CLEAN = ALL_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const HOST = readFileSync('src-tauri/src/lib.rs', 'utf8');

/** The panel's own timing budget, in milliseconds (AGENTS.md §1.2). */
const FEEDBACK_MIN_MS = 100;
const TRAVEL_MAX_MS = 320;

/**
 * Properties that cannot interpolate. They step whatever duration they are given,
 * which is why the idiom for taking an element out of the tab order is
 * `visibility 0s linear 150ms` — the travel belongs to the `opacity` beside it, and
 * the delay is when the step lands. They are therefore outside the budget; a rule
 * that relies on them is still checked through its neighbours.
 */
const DISCRETE_PROPERTIES = new Set(['visibility', 'display', 'content']);

interface Declaration {
  property: string;
  value: string;
}

interface Block {
  /** The selector list as written, one entry per selector. */
  selectors: string[];
  body: string;
  /** The enclosing at-rule prelude, when there is one (`@media (...)`). */
  atRule?: string;
}

const normalise = (text: string) => text.trim().replace(/\s+/g, ' ');

/** Split on `separator`, ignoring anything nested in parentheses or quotes. */
function splitTop(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of value) {
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    if (character === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

function declarations(body: string): Declaration[] {
  return splitTop(body, ';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const colon = entry.indexOf(':');
      return { property: entry.slice(0, colon).trim(), value: entry.slice(colon + 1).trim() };
    })
    .filter((entry) => entry.property.length > 0);
}

/** Every style rule in the sheet, and every `@keyframes` block by name. */
function parse(css: string): { blocks: Block[]; keyframes: Map<string, string> } {
  const blocks: Block[] = [];
  const keyframes = new Map<string, string>();

  const walk = (start: number, end: number, atRule?: string) => {
    let index = start;
    while (index < end) {
      const open = css.indexOf('{', index);
      if (open === -1 || open >= end) return;
      let depth = 0;
      let cursor = open;
      for (; cursor < end; cursor += 1) {
        if (css[cursor] === '{') depth += 1;
        else if (css[cursor] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const prelude = css.slice(index, open).trim();
      const body = css.slice(open + 1, cursor);
      if (prelude.startsWith('@keyframes')) {
        keyframes.set(normalise(prelude.replace('@keyframes', '')), body);
      } else if (prelude.startsWith('@')) {
        walk(open + 1, cursor, prelude);
      } else {
        blocks.push({
          selectors: splitTop(prelude, ',').map(normalise).filter(Boolean),
          body,
          atRule
        });
      }
      index = cursor + 1;
    }
  };

  walk(0, css.length);
  return { blocks, keyframes };
}

const { blocks, keyframes } = parse(CLEAN);

const isReducedMotion = (block: Block) => block.atRule?.includes('prefers-reduced-motion') === true;
/** Rules that run for everyone: the reduced-motion blocks are the escape hatch. */
const live = blocks.filter((block) => !isReducedMotion(block));
const reduced = blocks.filter(isReducedMotion);

/**
 * Every rule that names this selector. A selector can be split across blocks (a
 * shared "shape" rule and its own rule), and a transition declared in either one
 * applies, so the motion checks read all of them.
 */
function blocksFor(selector: string, pool: Block[] = live): Block[] {
  const wanted = normalise(selector);
  const found = pool.filter((block) => block.selectors.includes(wanted));
  expect(found.length, `no rule for ${selector}`).toBeGreaterThan(0);
  return found;
}

interface Motion {
  property: string;
  durationMs: number;
}

const duration = (token: string): number | undefined => {
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(token);
  if (!match) return undefined;
  return match[2] === 's' ? Number(match[1]) * 1000 : Number(match[1]);
};

/** The properties a rule transitions, with the duration each one travels over. */
function transitionsOf(block: Block): Motion[] {
  const declared = declarations(block.body);
  const shorthand = declared.filter((entry) => entry.property === 'transition');
  const motions: Motion[] = [];
  for (const entry of shorthand) {
    for (const part of splitTop(entry.value, ',')) {
      const tokens = part.trim().split(/\s+/).filter(Boolean);
      const property = tokens[0];
      // `transition: none` is a deliberate silence, checked on its own below.
      if (!property || property === 'none') continue;
      const time = tokens.map(duration).find((value) => value !== undefined);
      motions.push({ property, durationMs: time ?? 0 });
    }
  }
  // Longhands are read too, so a block that prefers them is not silently exempt.
  const properties = declared
    .filter((entry) => entry.property === 'transition-property')
    .flatMap((entry) => splitTop(entry.value, ',').map(normalise))
    .filter((property) => property && property !== 'none');
  const durations = declared
    .filter((entry) => entry.property === 'transition-duration')
    .flatMap((entry) => splitTop(entry.value, ',').map((value) => duration(normalise(value)) ?? 0));
  properties.forEach((property, index) => {
    motions.push({ property, durationMs: durations[index % Math.max(1, durations.length)] ?? 0 });
  });
  return motions;
}

interface Animation {
  name: string;
  durationMs: number;
  loop: boolean;
}

const ANIMATION_KEYWORDS = new Set([
  'none',
  'normal',
  'reverse',
  'alternate',
  'alternate-reverse',
  'forwards',
  'backwards',
  'both',
  'running',
  'paused',
  'infinite',
  'ease',
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'step-start',
  'step-end'
]);

/** The animations a rule runs, by name, with the duration and whether it loops. */
function animationsOf(block: Block): Animation[] {
  const animations: Animation[] = [];
  for (const entry of declarations(block.body)) {
    if (entry.property !== 'animation' && entry.property !== 'animation-name') continue;
    const names =
      entry.property === 'animation-name'
        ? splitTop(entry.value, ',').map(normalise)
        : splitTop(entry.value, ',').map(
            (part) =>
              part
                .trim()
                .split(/\s+/)
                .find(
                  (token) =>
                    !ANIMATION_KEYWORDS.has(token) && duration(token) === undefined && !token.startsWith('cubic-bezier')
                ) ?? ''
          );
    const durations =
      entry.property === 'animation-name'
        ? declarations(block.body)
            .filter((other) => other.property === 'animation-duration')
            .flatMap((other) => splitTop(other.value, ',').map((value) => duration(normalise(value)) ?? 0))
        : splitTop(entry.value, ',').map((part) => part.split(/\s+/).map(duration).find((value) => value !== undefined) ?? 0);
    const loop = entry.property === 'animation' && /(^|\s)infinite(\s|$)/.test(entry.value);
    names
      .filter((name) => name.length > 0 && name !== 'none')
      .forEach((name, index) => {
        animations.push({ name, durationMs: durations[index % Math.max(1, durations.length)] ?? 0, loop });
      });
  }
  return animations;
}

/**
 * A switch that changes state on one element, so its travel is a `transition` on
 * that element's own rule. `properties` lists every property that moves when the
 * switch happens; the guard fails if any of them is left out.
 */
interface TransitionSwitch {
  what: string;
  selector: string;
  properties: string[];
}

const TRANSITION_SWITCHES: TransitionSwitch[] = [
  { what: 'panel fades in and out with the window', selector: '#panel-root', properties: ['opacity', 'transform'] },
  {
    what: 'toolbar icon buttons: hover, pressed pin, disabled',
    selector: '.icon-button',
    properties: ['border-color', 'background-color', 'color', 'opacity']
  },
  { what: 'sync dot lights up when a sync lands', selector: '.panel-footer-dot', properties: ['background-color'] },
  { what: 'connection trigger appears and responds to hover', selector: '.connection-trigger', properties: ['opacity', 'visibility', 'background-color', 'border-color'] },
  { what: 'bottom module leaves with the hidden header', selector: '.panel-bottom', properties: ['opacity', 'transform', 'visibility'] },
  { what: 'connection details open above the footer', selector: '.connection-details', properties: ['opacity', 'transform', 'visibility'] },
  { what: 'card gear turns to the accent on hover', selector: '.gear-button', properties: ['color'] },
  {
    // The pinned panel's header settles away while it is out of focus: the
    // height travel is scripted (panel-header.ts), CSS owns the divider fade
    // and the delayed visibility step that lands when the height reaches zero.
    what: 'the pinned header collapse steps its contents out of the tab order',
    selector: '.panel-header',
    properties: ['border-bottom-color', 'visibility']
  },
  {
    // The line turns into "等待刷新" in place; the words are replaced, while its
    // tone is the property that carries both the state change and hover feedback.
    what: 'reset line turns into 等待刷新 and responds to hover',
    selector: '.quota-reset',
    properties: ['color']
  },
  {
    what: 'quota shape gains a hover and pressed surface',
    selector: '.quota-shape-button',
    properties: ['background-color']
  },
  {
    what: 'the quota arc and the quota bar follow the reading',
    selector: '.quota-shape-fill',
    properties: ['stroke-dasharray', 'stroke']
  },
  {
    what: 'ring quota digits take the warning colour',
    selector: '.quota-item-ringtext',
    properties: ['fill']
  },
  {
    what: 'the ring percent sign takes the warning colour',
    selector: '.quota-item-ringtext .pct',
    properties: ['fill']
  },
  {
    what: 'bar quota digits take the warning colour',
    selector: '.quota-item-head .quota-value',
    properties: ['color']
  },
  {
    what: 'a balance amount takes and gives back the low-value warning colour',
    selector: '.metric-value',
    properties: ['color']
  },
  {
    what: 'refreshed ring digits take the warning colour',
    selector: '.quota-ring-replay',
    properties: ['color']
  },
  {
    what: 'the refreshed ring percent sign takes the warning colour',
    selector: '.quota-ring-replay .replay-number-percent',
    properties: ['color']
  },
  { what: '估算 / 已过期 badge changes tone', selector: '.tag', properties: ['border-color', 'color'] },
  { what: 'connection dot changes tone', selector: '.status-dot', properties: ['background-color'] },
  { what: 'status word takes the tone of its row', selector: '.status-label', properties: ['color'] },
  {
    what: 'the provider card peak rail appears without turning the card into a warning',
    selector: '.provider-card::before',
    properties: ['opacity', 'transform']
  },
  {
    what: 'the peak corner appears only while the provider is in peak',
    selector: '.peak-corner',
    properties: ['color', 'background-color', 'border-color', 'opacity', 'transform', 'visibility']
  },
  {
    what: 'a message withdraws from the stack',
    selector: '.panel-toast',
    properties: ['opacity', 'transform']
  },
  {
    what: 'ghost button: hover and disabled',
    selector: '.ghost-button',
    properties: ['border-color', 'background-color', 'color']
  },
  {
    // The disabled state is a surface swap now, not a fade: the control used to
    // drop to `opacity: 0.5`, which on the light theme left a white label on a
    // half-opacity blue and said nothing about what the button would do.
    what: 'primary button: hover and the disabled surface',
    selector: '.primary-button',
    properties: ['border-color', 'background-color', 'color']
  },
  {
    // The confirmation step for deleting a credential: it wears the danger tone as
    // a surface, the way the primary button wears the action tone.
    what: 'danger button: hover and the disabled surface',
    selector: '.danger-button',
    properties: ['border-color', 'background-color', 'color']
  },
  {
    // Now takes the disabled tone while a credential is being validated, which it
    // previously showed not at all (same colour, same `cursor: pointer`).
    what: 'link button: hover and disabled',
    selector: '.link-button',
    properties: ['color']
  },
  {
    what: 'segmented option lights up for theme, global quota value, region and reminder switches',
    selector: '.segmented-option',
    properties: ['background-color', 'color', 'box-shadow', 'opacity']
  },
  {
    what: 'a single selected pill slides and resizes between mutually exclusive options',
    selector: '.segmented-slider',
    properties: ['transform', 'width', 'background-color', 'box-shadow']
  },
  {
    what: 'hidden platform row lifts while it is dragged',
    selector: '.manage-row',
    properties: ['background-color', 'box-shadow']
  },
  { what: 'drag grip brightens on hover', selector: '.drag-handle', properties: ['color'] },
  {
    // The disabled fade is part of the same switch: its own save greys the
    // control out and back, and that has to travel like every other state change.
    what: 'platform switch track, rim and disabled fade',
    selector: '.switch',
    properties: ['background-color', 'border-color', 'opacity']
  },
  { what: 'platform switch thumb slides and takes the accent', selector: '.switch::after', properties: ['transform', 'background-color'] },
  {
    // The settings window's nav: moving between sections moves the tint, the text
    // colour and the rim together, on the feedback budget.
    what: 'settings section selection travels',
    selector: '.settings-nav-item',
    properties: ['background-color', 'color', 'border-color']
  },
  {
    // The accent rail is part of the same switch: a section that becomes current
    // grows it out of nothing, which is a dimension and travels on that budget.
    what: 'settings section accent rail grows for the current section',
    selector: '.settings-nav-item::before',
    properties: ['height', 'opacity']
  },
  {
    what: 'settings nav badge takes the accent with its section',
    selector: '.settings-nav-badge',
    properties: ['background-color', 'color']
  },
  {
    // One custom peak window. It mounts already lowered and transparent, so the
    // travel is the `animation` registered below; what travels here is its exit,
    // which is a state (`is-leaving`) rather than an unmount — see the item below.
    what: 'a removed peak window fades and lifts out of the schedule',
    selector: '.peak-window-card',
    properties: ['opacity', 'transform']
  },
  {
    // The list closes with the row instead of snapping when React drops it. The
    // collapse is the item's own track and margin, because a container `gap` is
    // not part of any element and could not be animated away.
    what: 'the schedule list closes as a removed window leaves',
    selector: '.peak-window-item',
    properties: ['grid-template-rows', 'margin-bottom']
  },
  {
    // Always in the box, revealed on the row that wraps: mounting it on demand
    // would shove the two time fields sideways rather than fade the marker in.
    what: 'the 跨天 marker fades in on a window that passes midnight',
    selector: '.peak-overnight',
    properties: ['opacity', 'transform', 'visibility']
  },
  {
    what: 'the add-window button responds to hover and disabled',
    selector: '.peak-add',
    properties: ['border-color', 'background-color', 'color', 'opacity']
  },
  {
    what: 'the remove-window button responds to hover and disabled',
    selector: '.peak-remove',
    properties: ['border-color', 'background-color', 'color', 'opacity']
  },
  {
    what: 'the peak preview strip takes the warning tone as the period flips',
    selector: '.peak-verdict',
    properties: ['border-color', 'color']
  },
  {
    what: 'the peak preview dot lights with the period',
    selector: '.peak-verdict-dot',
    properties: ['background-color']
  },
  {
    // Declared on the resting rule so the tone travels both ways; a transition on
    // the failure class alone would animate in and cut back out. `color` is part of
    // the same switch: the disabled state changes the label's tone too, and leaving
    // it out let a field snap its text while its border faded.
    what: 'a text input takes the failure or disabled treatment and gives it back',
    selector: '.text-input',
    properties: ['border-color', 'background-color', 'color']
  },
  {
    // A disabled sliding group must not dim the text under the moving pill, so the
    // track carries the state instead — otherwise "busy" was invisible.
    what: 'a busy segmented group shows it on its track',
    selector: '.segmented',
    properties: ['border-color', 'background-color']
  },
  {
    // The confirmation's buttons are taller than a line of text: the row grows, and
    // the growth travels rather than shifting every block below it.
    what: 'the credential status row grows for the deletion confirmation',
    selector: '.credential-status',
    properties: ['min-height']
  },
  {
    what: 'a hidden platform\'s name drops a level',
    selector: '.manage-text strong',
    properties: ['color']
  },
  {
    // Revealed rather than mounted, so the marker reserves its width and the fade is
    // what the reader sees — mounting it popped it in and shoved the name sideways.
    what: 'the 已隐藏 marker fades in on a hidden platform',
    selector: '.manage-hidden-tag',
    properties: ['opacity', 'transform', 'visibility']
  },
];

/**
 * A switch that mounts its element already in the new state, so its travel is an
 * `animation`: the element is new, and a transition needs a previous value.
 */
interface AnimationSwitch {
  what: string;
  selectors: string[];
  animation: string;
}

const ANIMATION_SWITCHES: AnimationSwitch[] = [
  { what: 'the refresh icon turns while requests are in flight', selectors: ['.icon-button.is-busy svg'], animation: 'panel-refresh-spin' },
  { what: 'successful refresh restarts quota fill from zero', selectors: ['.quota-item.is-replaying .quota-shape-fill'], animation: 'quota-refresh-fill' },
  { what: 'successful refresh rolls visible digit columns from zero', selectors: ['.rolling-number-strip'], animation: 'replay-digit-roll' },
  { what: 'a message arrives in the stack', selectors: ['.panel-toast'], animation: 'panel-toast-in' },
  {
    what: 'an auxiliary card section arrives without shifting its measured layout',
    selectors: ['.card-section-secondary'],
    animation: 'card-section-in'
  },
  {
    // A settings section mounts already in its new state, so there is no previous
    // value to move from: its travel is an animation. The pane's React key is the
    // section, which is what re-runs it.
    what: 'a settings section arrives in the content area',
    selectors: ['.settings-pane'],
    animation: 'settings-pane-in'
  },
  {
    what: 'credential feedback takes its own row under the stored state',
    selectors: ['.credential-feedback'],
    animation: 'credential-feedback-in'
  },
  {
    // The deletion confirmation replaces the status line in place. Both the prompt
    // and the two buttons mount with it, so they arrive on an animation.
    what: 'the credential deletion confirmation arrives in the status row',
    selectors: ['.credential-confirm-prompt', '.credential-confirm'],
    animation: 'credential-confirm-in'
  },
  {
    // Both arrive with the element already in its final state, so both travel on
    // an animation: a new schedule window, and the placeholder that takes the
    // list's place once the last one has left.
    what: 'a new peak window — or the empty-schedule placeholder — arrives',
    selectors: ['.peak-window-card', '.peak-empty'],
    animation: 'peak-window-in'
  },
  { what: 'the loading spinner turns', selectors: ['.spinner'], animation: 'panel-spin' }
];

/**
 * Switches the sheet cannot carry: instant on purpose, or travelled in script
 * because CSS has nothing to interpolate (the quota morph's path data, and the
 * window height, which the host can only set). Each one needs a reason, because
 * "it was easier" is not one — AGENTS.md §1.6 — and the test below checks the
 * reason still describes the code.
 */
interface Exception {
  what: string;
  selector: string;
  reason: string;
  /** Still true while the exception is needed: the condition that forces it. */
  whileHolds: RegExp;
  /** Where that condition is written. */
  where: string;
}

const EXCEPTIONS: Exception[] = [
  {
    what: 'the light/dark theme swap',
    selector: ":root[data-theme='light']",
    reason:
      'A palette swap changes custom properties, and the surface that changes with it is a linear-gradient background: gradients do not interpolate, so a CSS transition cannot cover the swap. Cross-fading the whole panel needs View Transitions.',
    whileHolds: /\.panel\s*\{[^}]*linear-gradient/,
    where: 'src/desktop/panel.css'
  },
  {
    what: 'a dragged row following the pointer',
    selector: '.manage-row',
    reason:
      'The dragged row is moved by the drag code writing transform every frame. A transition on transform would make it trail the cursor, so only its tint and shadow travel.',
    whileHolds: /will-change:\s*transform/,
    where: 'src/desktop/panel.css'
  },
  {
    what: 'focus rings',
    selector: '.quota-reset-toggle:focus-visible',
    reason:
      'Keyboard focus must be visible on the frame it arrives: an animated outline reads as the panel being slow to respond, and prefers-reduced-motion cannot help inside a focus ring.',
    whileHolds: /outline:\s*1px solid var\(--action\)/,
    where: 'src/desktop/panel.css'
  },
  {
    what: 'the ring <-> bar morph',
    selector: '.quota-shape',
    reason:
      'Both display forms are one stroke along one path, and WebKit has no interpolable CSS property for path data — there is no `d` to transition, so no transition or animation can draw the between frames. QuotaDisplay therefore walks the morph a frame at a time from one progress value, exactly as it walks the window height, and the three beats plus the speed profile live in quota-morph.ts. That one number also moves what its own rules cannot derive: the drop the bar travels, the slower fade of the label line, and the shift that carries the reset line from under the ring to the left edge of the item. `prefers-reduced-motion` skips the walk and draws the landing frame directly (pinned in tests/panel-quota-morph.test.tsx). It is motion, travelled by script rather than by the sheet, and it is the one switch allowed past the travel budget: the design asks for three beats — break and unwind, straighten, drop — and each has to be seen.',
    whileHolds: /quotaShape\(/,
    where: 'src/desktop/panel/QuotaDisplay.tsx'
  },
  {
    what: 'the frosted cover over placeholder data',
    selector: '.frost-hint',
    reason:
      'The cover hides the placeholder values a card falls back to (28% / 16% and a ¥42.60 wallet). Any entrance — of the cover or of its text — spends its whole duration showing what it hides, and returning from a settings page remounts the card that carries it. It has to be complete on the first frame.',
    whileHolds: /PLACEHOLDER_(QUOTA|WALLET)/,
    where: 'src/desktop/panel/GlmCard.tsx'
  }
];

/** Property names a required one may be written as (shorthand for the longhand). */
const PROPERTY_ALIASES: Record<string, string[]> = {
  'background-color': ['background'],
  'border-color': ['border'],
  'border-bottom-color': ['border-bottom']
};

const covers = (declared: string, required: string) =>
  declared === required || (PROPERTY_ALIASES[required] ?? []).includes(declared);

describe('panel motion: every registered switch travels', () => {
  it('starts successful-refresh progress and digit reels at zero', () => {
    expect(keyframes.get('quota-refresh-fill')).toMatch(/stroke-dasharray:\s*0 100/);
    expect(keyframes.get('replay-digit-roll')).toMatch(/transform:\s*translateY\(0\)/);
    expect(blocksFor('.rolling-number-reel').map((block) => block.body).join(' ')).toMatch(/overflow:\s*hidden/);
  });

  for (const entry of TRANSITION_SWITCHES) {
    it(`${entry.what} — ${entry.selector}`, () => {
      const motions = blocksFor(entry.selector).flatMap(transitionsOf);
      expect(motions.length, `${entry.selector} declares no transition`).toBeGreaterThan(0);
      for (const property of entry.properties) {
        const covering = motions.filter((motion) => covers(motion.property, property));
        expect(
          covering.length,
          `${entry.selector} changes ${property} without a transition — add it to the transition list`
        ).toBeGreaterThan(0);
        // A discrete property steps on purpose; its travel is the neighbour's.
        if (DISCRETE_PROPERTIES.has(property)) continue;
        expect(
          covering.every((motion) => motion.durationMs > 0),
          `${entry.selector} transitions ${property} with no duration`
        ).toBe(true);
      }
    });
  }

  for (const entry of ANIMATION_SWITCHES) {
    it(`${entry.what} — @keyframes ${entry.animation}`, () => {
      for (const selector of entry.selectors) {
        const running = blocksFor(selector).flatMap(animationsOf);
        expect(
          running.map((animation) => animation.name),
          `${selector} does not run ${entry.animation}`
        ).toContain(entry.animation);
      }
      const frames = keyframes.get(entry.animation);
      expect(frames, `@keyframes ${entry.animation} is missing`).toBeDefined();
      expect(frames!.trim().length, `@keyframes ${entry.animation} has no steps`).toBeGreaterThan(0);
    });
  }
});

describe('panel card hover', () => {
  it('leaves the non-interactive card itself without hover feedback', () => {
    expect(blocks.filter((block) => block.selectors.includes('.provider-card:hover'))).toEqual([]);
  });

  it('keeps reset-time links free of an underline', () => {
    const declarationsForToggle = blocksFor('.quota-reset-toggle').flatMap((entry) => declarations(entry.body));
    expect(declarationsForToggle.some((entry) => entry.property.startsWith('border-bottom'))).toBe(false);
  });
});

describe('segmented selection travel', () => {
  it('slides on the displacement budget and resizes on the dimension budget', () => {
    const motions = blocksFor('.segmented-slider').flatMap(transitionsOf);
    const transform = motions.find((motion) => motion.property === 'transform');
    const width = motions.find((motion) => motion.property === 'width');
    expect(transform?.durationMs).toBeGreaterThanOrEqual(160);
    expect(transform?.durationMs).toBeLessThanOrEqual(180);
    expect(width?.durationMs).toBeGreaterThanOrEqual(200);
    expect(width?.durationMs).toBeLessThanOrEqual(260);
  });
});

describe('segmented choice feedback', () => {
  const mountStyles = (markup: string) => {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    const root = document.createElement('div');
    root.innerHTML = markup;
    document.body.append(root);
    return { root, sheet: style.sheet!, cleanup: () => { root.remove(); style.remove(); } };
  };

  it('keeps a sliding choice fully visible while its save disables repeat clicks', () => {
    const fixture = mountStyles('<div class="segmented has-slider"><button class="segmented-option" disabled>已用</button></div>');
    try {
      const button = fixture.root.querySelector('button')!;
      expect(window.getComputedStyle(button).opacity).toBe('1');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not brighten sliding-choice text on hover while preserving weekday hover feedback', () => {
    const fixture = mountStyles('<div class="segmented has-slider"><button class="segmented-option">已用</button></div><div class="segmented peak-weekdays"><button class="segmented-option">一</button></div>');
    try {
      const hoverRules = [...fixture.sheet.cssRules]
      .map((rule) => ('selectorText' in rule ? String(rule.selectorText) : ''))
      .filter((selector) => selector.includes('.segmented-option') && selector.includes(':hover'));
      const [single, weekday] = fixture.root.querySelectorAll('button');
      single!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(hoverRules.some((selector) => single!.matches(selector))).toBe(false);
      weekday!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(hoverRules.some((selector) => weekday!.matches(selector))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('panel motion: the sheet stays inside the budget', () => {
  it('gives every transition a duration inside the panel budget', () => {
    for (const block of live) {
      for (const motion of transitionsOf(block)) {
        if (DISCRETE_PROPERTIES.has(motion.property)) continue;
        expect(
          motion.durationMs,
          `${block.selectors.join(', ')} transitions ${motion.property} outside ${FEEDBACK_MIN_MS}–${TRAVEL_MAX_MS}ms`
        ).toBeGreaterThanOrEqual(FEEDBACK_MIN_MS);
        expect(motion.durationMs).toBeLessThanOrEqual(TRAVEL_MAX_MS);
      }
    }
  });

  it('gives every animation a duration inside the budget, apart from loops', () => {
    for (const block of live) {
      for (const animation of animationsOf(block)) {
        // A loop is not a switch: it runs for as long as the state lasts.
        if (animation.loop) continue;
        expect(
          animation.durationMs,
          `${block.selectors.join(', ')} runs ${animation.name} outside ${FEEDBACK_MIN_MS}–${TRAVEL_MAX_MS}ms`
        ).toBeGreaterThanOrEqual(FEEDBACK_MIN_MS);
        expect(animation.durationMs).toBeLessThanOrEqual(TRAVEL_MAX_MS);
      }
    }
  });

  it('keeps the panel fade shorter than the host waits before hiding the window', () => {
    const hostWait = /PANEL_HIDE_ANIMATION_MS:\s*u64\s*=\s*(\d+)/.exec(HOST);
    expect(hostWait, 'PANEL_HIDE_ANIMATION_MS not found in src-tauri/src/lib.rs').toBeDefined();
    const fade = blocksFor('#panel-root').flatMap(transitionsOf);
    for (const motion of fade) {
      expect(
        motion.durationMs,
        `the panel fade (${motion.durationMs}ms) must finish before the host hides the window (${hostWait![1]}ms)`
      ).toBeLessThan(Number(hostWait![1]));
    }
  });

  it('keeps the window height travel inside the budget too', () => {
    // The one switch CSS cannot make: the host can only set a size, so the panel
    // reports a height per frame (see panel-height.ts).
    expect(PANEL_HEIGHT_ANIMATION_MS).toBeGreaterThanOrEqual(FEEDBACK_MIN_MS);
    expect(PANEL_HEIGHT_ANIMATION_MS).toBeLessThanOrEqual(TRAVEL_MAX_MS);
  });

  it('never reaches for `transition: all`', () => {
    for (const block of live) {
      for (const motion of transitionsOf(block)) {
        expect(
          motion.property,
          `${block.selectors.join(', ')} transitions every property: it would animate layout, and the window height is measured from this content`
        ).not.toBe('all');
      }
    }
  });
});

describe('panel motion: nothing is silenced outside the preference', () => {
  it('turns motion off only under prefers-reduced-motion', () => {
    for (const block of live) {
      for (const entry of declarations(block.body)) {
        const silencesTransition = entry.property === 'transition' || entry.property === 'transition-property';
        const silencesAnimation = entry.property === 'animation' || entry.property === 'animation-name';
        if (!silencesTransition && !silencesAnimation) continue;
        expect(
          normalise(entry.value).startsWith('none'),
          `${block.selectors.join(', ')} silences ${entry.property} outside prefers-reduced-motion`
        ).toBe(false);
      }
    }
  });

  it('has a blanket that covers every switch when the preference is set', () => {
    const blanket = reduced.filter((block) => block.selectors.includes('*'));
    expect(blanket.length, 'no `*` rule in a prefers-reduced-motion block').toBeGreaterThan(0);
    const body = blanket.map((block) => block.body).join(' ');
    // `!important` is load-bearing: a bare `*` rule loses to every class rule, and
    // those class rules declare exactly the transitions this blanket removes.
    expect(body).toMatch(/transition:\s*none\s*!important/);
    expect(body).toMatch(/animation:\s*none\s*!important/);
  });

  it('documents the switches that are instant on purpose, and why they still are', () => {
    for (const exception of EXCEPTIONS) {
      expect(exception.reason.length, `${exception.what} needs a real reason`).toBeGreaterThan(40);
      blocksFor(exception.selector, blocks);
      const source = readFileSync(exception.where, 'utf8');
      expect(
        exception.whileHolds.test(source.replace(/\/\*[\s\S]*?\*\//g, '')),
        `${exception.what} is listed as a deliberate exception, but its cause is gone — animate it or drop the entry`
      ).toBe(true);
    }
  });
});

describe('panel motion: a cover protects what it covers', () => {
  // The frosted cover exists to hide the placeholder values a card falls back to
  // when a module has no data (`GlmCard` draws 28% / 16% and a ¥42.60 wallet to keep
  // the shape realistic). Two ways it has leaked those numbers, both pinned here:
  // an entrance animation that spends its duration transparent, and a veil so thin
  // that the blur was doing all the hiding — which fails for the frames where the
  // engine has not sampled the backdrop yet.
  const COVER = ['.frost-hint', '.frost-hint-label', '.frost-hint-detail'];

  it('never animates the cover or its text in', () => {
    for (const selector of COVER) {
      for (const motion of blocksFor(selector).flatMap(transitionsOf)) {
        expect(
          motion.property,
          `${selector} must not transition: the cover and its hint are complete on the first frame`
        ).not.toBe('opacity');
      }
      for (const animation of blocksFor(selector).flatMap(animationsOf)) {
        const frames = keyframes.get(animation.name) ?? '';
        expect(
          animation.name,
          `${selector} runs ${animation.name}: an entrance for a cover shows what the cover hides`
        ).toBe('');
        expect(frames).toBe('');
      }
    }
  });

  it('hides the placeholder data without depending on the blur', () => {
    const cover = blocksFor('.frost-hint')[0]!.body;
    expect(cover, 'the clickable cover must not advertise a link with a hand cursor').toMatch(/cursor:\s*default/);
    expect(cover, 'the button reset must not add its own border inside the module').toMatch(/border:\s*0/);
    // The hiding lives on the covered content, as a plain `filter`. A
    // `backdrop-filter` is sampled late (or not at all) for a cover that mounts
    // inside an animating card — which every page swap does — and while the
    // backdrop is missing the placeholder numbers are perfectly readable.
    expect(
      cover,
      '.frost-hint must not rely on backdrop-filter: engines sample the backdrop late for a cover that mounts inside an animating card'
    ).not.toMatch(/backdrop-filter/);
    const blurred = blocksFor('.is-covered > :not(.frost-hint)')[0]!.body;
    expect(
      blurred,
      '.is-covered > :not(.frost-hint) must blur the covered content: the blur has to be painted with the content it hides'
    ).toMatch(/filter:\s*blur\(/);
    expect(blurred, 'the covered content must be dimmed as well').toMatch(/opacity:/);
    const secondary = blocksFor('.card-section-secondary')[0]!.body;
    expect(secondary, 'a subtle divider separates auxiliary data without a nested card outline').toMatch(
      /border-top:\s*1px solid var\(--line-soft\)/
    );
    const web = blocksFor('.deepseek-web')[0]!.body;
    expect(web).not.toMatch(/border:\s*1px solid/);
    const wallet = blocksFor('.glm-wallet')[0]!.body;
    expect(wallet, 'the GLM wallet should not gain a heavier outline').not.toMatch(/border:\s*1px solid/);
    const alphas = [...CLEAN.matchAll(/--cover-bg:\s*rgba\([^)]*?,\s*([\d.]+)\s*\)/g)].map((match) =>
      Number(match[1])
    );
    // Two palettes, one tint each: it dims what the blur already hides.
    expect(alphas).toHaveLength(2);
    for (const alpha of alphas) {
      expect(alpha, `--cover-bg alpha ${alpha} is not a tint at all`).toBeGreaterThanOrEqual(0.4);
    }
  });
});
