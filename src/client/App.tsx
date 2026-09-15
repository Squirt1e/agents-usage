import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProviderId } from '../shared/contracts';
import { Dashboard, type ProviderViewState } from './Dashboard';
import { SettingsPanel, type DashboardSettings } from './SettingsPanel';

const emptySettings: DashboardSettings = { glmRegion: 'china', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, experimental: { glmWallet: false }, credentials: { glm: { configured: false }, deepseek: { configured: false }, glmWallet: { configured: false }, codex: { delegated: true } } };

export function App() {
  const [providers, setProviders] = useState<ProviderViewState[]>([]);
  const [settings, setSettings] = useState<DashboardSettings>(emptySettings);
  const [sessionToken, setSessionToken] = useState('');
  const [refreshing, setRefreshing] = useState<Set<ProviderId>>(new Set());
  const [now, setNow] = useState(() => new Date());
  const [message, setMessage] = useState('正在读取本地缓存…');
  const loadSnapshots = useCallback(async () => { const response = await fetch('/api/snapshots'); if (!response.ok) throw new Error('无法读取本地快照'); setProviders(((await response.json()) as { providers: ProviderViewState[] }).providers); }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([fetch('/api/bootstrap').then(async (response) => { if (!response.ok) throw new Error('本地服务初始化失败'); const data = await response.json() as { sessionToken: string; settings: DashboardSettings }; if (active) { setSessionToken(data.sessionToken); setSettings(data.settings); } }), loadSnapshots()]).then(() => { if (active) setMessage('本地采集 · 只读面板'); }).catch((error) => { if (active) setMessage(error instanceof Error ? error.message : '本地服务不可用'); });
    const events = new EventSource('/events');
    events.addEventListener('snapshot', (event) => { const data = JSON.parse((event as MessageEvent).data) as { providers: ProviderViewState[] }; if (active) setProviders(data.providers); });
    events.addEventListener('provider', () => { if (active) void loadSnapshots(); });
    events.onerror = () => { if (active) setMessage('实时连接中断，正在使用缓存数据'); };
    const clock = window.setInterval(() => setNow(new Date()), 30_000);
    return () => { active = false; events.close(); window.clearInterval(clock); };
  }, [loadSnapshots]);
  const mutationHeaders = useMemo(() => ({ 'Content-Type': 'application/json', 'X-Session-Token': sessionToken }), [sessionToken]);
  const refresh = async (provider: ProviderId) => { setRefreshing((current) => new Set(current).add(provider)); try { const response = await fetch(`/api/refresh/${provider}`, { method: 'POST', headers: mutationHeaders }); const data = await response.json() as { nextEligibleAt?: string }; if (response.status === 429) setMessage(`刷新冷却中，可于 ${new Date(data.nextEligibleAt!).toLocaleTimeString()} 后重试`); else if (!response.ok) setMessage(`${provider} 刷新失败，继续显示上次数据`); else setMessage(`${provider} 已更新`); await loadSnapshots(); } finally { setRefreshing((current) => { const next = new Set(current); next.delete(provider); return next; }); } };
  const saveCredential = async (provider: 'glm' | 'deepseek' | 'glm-wallet', secret: string) => { const response = await fetch(`/api/credentials/${provider}`, { method: 'PUT', headers: mutationHeaders, body: JSON.stringify({ secret }) }); const payload = await response.json() as { configured?: boolean; suffix?: string; error?: string }; if (!response.ok) { const failure = payload.error ?? `${provider} 密钥验证失败`; setMessage(failure); throw new Error(failure); } const status = { configured: payload.configured === true, ...(payload.suffix ? { suffix: payload.suffix } : {}) }; const key = provider === 'glm-wallet' ? 'glmWallet' : provider; setSettings((current) => ({ ...current, credentials: { ...current.credentials, [key]: status } })); setMessage(`${provider} 密钥已安全保存`); };
  const deleteCredential = async (provider: 'glm' | 'deepseek' | 'glm-wallet') => { const response = await fetch(`/api/credentials/${provider}`, { method: 'DELETE', headers: mutationHeaders }); if (response.ok) { const key = provider === 'glm-wallet' ? 'glmWallet' : provider; setSettings((current) => ({ ...current, credentials: { ...current.credentials, [key]: { configured: false } } })); } };
  const saveSettings = async (partial: Partial<DashboardSettings>) => { const response = await fetch('/api/settings', { method: 'PUT', headers: mutationHeaders, body: JSON.stringify(partial) }); if (response.ok) setSettings(await response.json() as DashboardSettings); };
  const refreshAll = () => { void Promise.all((['codex', 'glm', 'deepseek'] as const).map((provider) => refresh(provider))); };
  return <main aria-label="AI 用量面板"><header className="hero"><div><span className="eyebrow">LOCAL USAGE CONSOLE</span><h1>一眼看清每个平台<br /><em>还能用多少</em></h1><p>订阅额度、钱包余额与今日消费集中呈现。所有数据只在本机采集。</p></div><div className="hero-meta"><span className="live-dot" />{message}</div></header><section className="overview" aria-labelledby="overview-heading"><div className="section-heading"><span className="eyebrow">OVERVIEW</span><h2 id="overview-heading">用量总览</h2><button type="button" className="secondary-button" aria-label="刷新全部平台" disabled={refreshing.size === 3} onClick={refreshAll}>{refreshing.size === 3 ? '全部刷新中…' : '刷新全部'}</button></div><Dashboard providers={providers} now={now} onRefresh={refresh} refreshing={refreshing} /></section><SettingsPanel settings={settings} onSaveCredential={saveCredential} onDeleteCredential={deleteCredential} onSaveSettings={saveSettings} /><footer className="page-footer"><span>agents-usage · local-first</span><span>不会调用模型、购买额度或修改订阅</span></footer></main>;
}
