import { useState, type FormEvent } from 'react';

type CredentialTarget = 'glm' | 'deepseek' | 'glm-wallet';
type CredentialFeedback = { tone: 'progress' | 'success' | 'error'; text: string };

export interface DashboardSettings {
  glmRegion: 'china' | 'international';
  timezone: string;
  experimental: { glmWallet: boolean };
  credentials: {
    glm: { configured: boolean; suffix?: string };
    deepseek: { configured: boolean; suffix?: string };
    glmWallet: { configured: boolean; suffix?: string };
    codex: { delegated: true };
  };
}

export function SettingsPanel(props: {
  settings: DashboardSettings;
  onSaveCredential: (provider: CredentialTarget, secret: string) => Promise<void>;
  onDeleteCredential: (provider: 'glm' | 'deepseek' | 'glm-wallet') => void;
  onSaveSettings: (settings: Partial<DashboardSettings>) => void;
}) {
  const [glmKey, setGlmKey] = useState('');
  const [deepSeekKey, setDeepSeekKey] = useState('');
  const [glmWalletKey, setGlmWalletKey] = useState('');
  const [saving, setSaving] = useState<Partial<Record<CredentialTarget, boolean>>>({});
  const [feedback, setFeedback] = useState<Partial<Record<CredentialTarget, CredentialFeedback>>>({});
  const credentialForm = (provider: CredentialTarget, label: string, value: string, setValue: (value: string) => void) => {
    const status = props.settings.credentials[provider === 'glm-wallet' ? 'glmWallet' : provider];
    const pending = saving[provider] === true;
    const currentFeedback = feedback[provider];
    const submit = async (event: FormEvent) => {
      event.preventDefault();
      if (!value.trim() || pending) return;
      setSaving((current) => ({ ...current, [provider]: true }));
      setFeedback((current) => ({ ...current, [provider]: { tone: 'progress', text: '正在验证并保存…' } }));
      try {
        await props.onSaveCredential(provider, value.trim());
        setValue('');
        setFeedback((current) => ({ ...current, [provider]: { tone: 'success', text: '密钥已验证并保存' } }));
      } catch (error) {
        setFeedback((current) => ({ ...current, [provider]: { tone: 'error', text: error instanceof Error ? error.message : '密钥验证失败' } }));
      } finally {
        setSaving((current) => ({ ...current, [provider]: false }));
      }
    };
    return <form className="credential-form" onSubmit={submit}>
      <label htmlFor={`${provider}-key`}>{label}</label>
      <div className="input-row"><input id={`${provider}-key`} type="password" autoComplete="off" value={value} disabled={pending} onChange={(event) => setValue(event.target.value)} placeholder={status.configured ? '输入新密钥以替换' : '仅保存在 macOS Keychain'} /><button type="submit" disabled={pending}>{pending ? '正在验证…' : status.configured ? '验证并替换' : '验证并保存'}</button></div>
      <div className="credential-status">{currentFeedback ? <span role={currentFeedback.tone === 'error' ? 'alert' : 'status'}>{currentFeedback.text}</span> : status.configured ? <span>已保存 ····{status.suffix}</span> : <span>尚未配置</span>}{status.configured && !pending && <button type="button" className="text-button" onClick={() => props.onDeleteCredential(provider)}>删除</button>}</div>
    </form>;
  };
  return <section className="settings-panel" id="settings" aria-labelledby="settings-heading">
    <div className="section-heading"><span className="eyebrow">CONNECTIONS</span><h2 id="settings-heading">连接设置</h2><p>密钥提交后只进入本地服务和系统钥匙串，页面不会读取已保存值。</p></div>
    <div className="settings-grid">
      <article className="settings-card"><h3>Codex</h3><p>身份验证由已安装的 Codex app-server 管理。若未登录，请在 Codex 中完成登录。</p><span className="delegated-pill">Codex 托管登录</span></article>
      <article className="settings-card"><h3>GLM Coding Plan</h3><label htmlFor="glm-region">服务区域</label><select id="glm-region" value={props.settings.glmRegion} onChange={(event) => props.onSaveSettings({ glmRegion: event.target.value as DashboardSettings['glmRegion'] })}><option value="china">中国区 · bigmodel.cn</option><option value="international">国际区 · z.ai</option></select>{credentialForm('glm', 'GLM Coding Plan API Key', glmKey, setGlmKey)}</article>
      <article className="settings-card"><h3>DeepSeek</h3>{credentialForm('deepseek', 'DeepSeek API Key', deepSeekKey, setDeepSeekKey)}</article>
    </div>
    <article className="experimental-panel"><div><span className="badge badge-experimental">实验功能</span><h3>GLM 钱包余额</h3><p>此数据源不是公开稳定 API，可能随时失效，并涉及额外的账号级凭据稳定性和凭据风险。</p>{props.settings.experimental.glmWallet && credentialForm('glm-wallet', 'GLM 钱包账号凭据', glmWalletKey, setGlmWalletKey)}</div><label className="switch"><input type="checkbox" checked={props.settings.experimental.glmWallet} onChange={(event) => props.onSaveSettings({ experimental: { glmWallet: event.target.checked } })} /><span>启用 GLM 钱包</span></label></article>
  </section>;
}
