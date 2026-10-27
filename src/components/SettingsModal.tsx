import { useState } from 'react';
import { sshConnect, sshDisconnect, sshExec, sshDetectTools, type ToolInfo } from '../lib/ssh';
import { toast } from '../lib/toast';
import { PROVIDERS, loadLLMSettings, saveLLMSettings, loadModelPrefs, toggleFavoriteModel, rememberRecentModel, providerNeedsKey, resolveKey, fetchProviderModels, type LLMSettings, type ModelPrefs } from '../lib/llm';

interface SettingsModalProps {
  onClose: () => void;
  onConnectionChange?: (connected: boolean) => void;
}

type Tab = 'ssh' | 'ai';

export default function SettingsModal({ onClose, onConnectionChange }: SettingsModalProps) {
  const [tab, setTab] = useState<Tab>('ssh');

  // SSH state
  const [host, setHost] = useState('192.168.1.100');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('kali');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<'disconnected' | 'connected'>('disconnected');
  const [sshLog, setSshLog] = useState<string>('');
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [busy, setBusy] = useState(false);

  // AI state
  const [ai, setAi] = useState<LLMSettings>(() => loadLLMSettings());
  const [aiSaved, setAiSaved] = useState(false);
  const [modelPrefs, setModelPrefs] = useState<ModelPrefs>(() => loadModelPrefs());
  const [liveModels, setLiveModels] = useState<string[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState('');

  const refreshModels = async () => {
    setLoadingModels(true);
    setModelsError('');
    try {
      const list = await fetchProviderModels(ai.provider, ai.baseUrl, ai.apiKey);
      setLiveModels(list);
      toast(`Loaded ${list.length} models from ${ai.provider}`, 'success');
    } catch (e: any) {
      setLiveModels(null);
      setModelsError(String(e).slice(0, 200));
      toast(`Could not load models from ${ai.provider}`, 'error');
    } finally {
      setLoadingModels(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    try {
      setSshLog('Connecting to ' + host + ':' + port + '...');
      const res = await sshConnect(host, port, username, password);
      setStatus('connected');
      setSshLog(res);
      onConnectionChange?.(true);
      try {
        setSshLog('Connected. Detecting tools...');
        const detected = await sshDetectTools();
        setTools(detected);
        const available = detected.filter((t) => t.available).length;
        setSshLog(`Connected. ${available}/${detected.length} tools found.`);
      } catch {
        setSshLog('Connected, but tool detection failed.');
      }
    } catch (e: any) {
      setSshLog('Error: ' + e);
      onConnectionChange?.(false);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    try {
      await sshDisconnect();
      setStatus('disconnected');
      setSshLog('Disconnected');
      onConnectionChange?.(false);
    } catch (e: any) {
      setSshLog('Error: ' + e);
    }
  };

  const test = async () => {
    try {
      const res = await sshExec('whoami && uname -a');
      setSshLog('Test result:\n' + res);
    } catch (e: any) {
      setSshLog('Error: ' + e);
    }
  };

  const saveAi = () => {
    // Keep a per-provider key map so switching providers doesn't clobber keys.
    const apiKeys = { ...(ai.apiKeys ?? {}) };
    if (ai.apiKey && providerNeedsKey(ai.provider)) apiKeys[ai.provider] = ai.apiKey;
    const next = { ...ai, apiKeys };
    saveLLMSettings(next);
    setAi(next);
    setModelPrefs(rememberRecentModel(ai.model));
    setAiSaved(true);
    toast(`AI settings saved — ${ai.provider} / ${ai.model}`, 'success');
    setTimeout(() => setAiSaved(false), 2000);
  };

  const providerInfo = PROVIDERS[ai.provider];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="w-[560px] max-h-[90vh] overflow-y-auto bg-bg-secondary border border-border rounded-lg">
        <div className="h-10 border-b border-border flex items-center justify-between px-4">
          <div className="flex gap-3">
            <button onClick={() => setTab('ssh')} className={`text-sm ${tab === 'ssh' ? 'text-accent-cyan font-semibold' : 'text-text-secondary'}`}>
              Kali SSH
            </button>
            <button onClick={() => setTab('ai')} className={`text-sm ${tab === 'ai' ? 'text-accent-cyan font-semibold' : 'text-text-secondary'}`}>
              AI Model
            </button>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-base">×</button>
        </div>

        {tab === 'ssh' && (
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2">
                <label className="text-xs text-text-secondary">Host</label>
                <input value={host} onChange={(e) => setHost(e.target.value)} className="w-full mt-1 px-2 py-1 bg-bg-tertiary border border-border rounded text-xs" />
              </div>
              <div>
                <label className="text-xs text-text-secondary">Port</label>
                <input type="number" value={port} onChange={(e) => setPort(parseInt(e.target.value))} className="w-full mt-1 px-2 py-1 bg-bg-tertiary border border-border rounded text-xs" />
              </div>
            </div>
            <div>
              <label className="text-xs text-text-secondary">Username</label>
              <input value={username} onChange={(e) => setUsername(e.target.value)} className="w-full mt-1 px-2 py-1 bg-bg-tertiary border border-border rounded text-xs" />
            </div>
            <div>
              <label className="text-xs text-text-secondary">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Kali user password"
                className="w-full mt-1 px-2 py-1 bg-bg-tertiary border border-border rounded text-xs"
              />
            </div>
            <div className="flex gap-2">
              {status === 'disconnected' ? (
                <button onClick={connect} disabled={busy} className="px-3 py-1 bg-accent-green/10 text-accent-green border border-accent-green/30 rounded text-xs disabled:opacity-50">{busy ? 'Connecting...' : 'Connect'}</button>
              ) : (
                <button onClick={disconnect} className="px-3 py-1 bg-accent-red/10 text-accent-red border border-accent-red/30 rounded text-xs">Disconnect</button>
              )}
              <button onClick={test} disabled={status !== 'connected'} className="px-3 py-1 bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/30 rounded text-xs disabled:opacity-50">Test (whoami)</button>
            </div>
            <div className="bg-black p-2 rounded h-24 overflow-y-auto font-mono text-xs whitespace-pre-wrap">{sshLog || 'Enter your Kali VM SSH details and click Connect.'}</div>
            {tools.length > 0 && (
              <div>
                <div className="text-xs text-text-secondary mb-1">Detected Tools ({tools.filter((t) => t.available).length}/{tools.length})</div>
                <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                  {tools.map((t) => (
                    <span key={t.name} className={`px-2 py-0.5 rounded text-[10px] border ${t.available ? 'bg-accent-green/10 text-accent-green border-accent-green/30' : 'bg-bg-tertiary text-text-secondary/50 border-border'}`}>
                      {t.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'ai' && (
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-text-secondary">Provider</label>
                <div className="grid grid-cols-2 gap-1 mt-1">
                  {Object.keys(PROVIDERS).map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        const info = PROVIDERS[p];
                        const key = info.noKey ? '' : resolveKey(ai, p);
                        setLiveModels(null);
                        setModelsError('');
                        setAi({ ...ai, provider: p, baseUrl: info.baseUrl, model: info.models[0], apiKey: key });
                      }}
                      className={`px-2 py-1.5 rounded text-xs border transition-colors ${
                        ai.provider === p
                          ? 'border-accent-cyan/60 bg-accent-cyan/10 text-accent-cyan'
                          : 'border-border bg-bg-tertiary text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs text-text-secondary">Model</label>
                  <button
                    onClick={refreshModels}
                    disabled={loadingModels || (providerNeedsKey(ai.provider) && !ai.apiKey)}
                    title={
                      providerNeedsKey(ai.provider) && !ai.apiKey
                        ? 'Enter an API key first'
                        : `Load the live model list from ${ai.provider}`
                    }
                    className="text-[10px] text-accent-cyan/80 hover:text-accent-cyan disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {loadingModels ? 'loading…' : liveModels ? `${liveModels.length} live ✓` : '↻ fetch live list'}
                  </button>
                </div>
                <input
                  value={ai.model}
                  onChange={(e) => setAi({ ...ai, model: e.target.value })}
                  list="model-list"
                  className="w-full mt-1 px-2 py-1.5 bg-bg-tertiary border border-border rounded text-xs"
                />
                <datalist id="model-list">
                  {(liveModels ?? providerInfo?.models ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                {modelsError && <div className="text-[10px] text-accent-red mt-1 break-all">{modelsError}</div>}
                <div className="text-[10px] text-text-secondary/50 mt-1">
                  {liveModels ? 'live list from provider' : 'presets — providers retire models, use ↻ to check live'}
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-text-secondary">favorites:</span>
                {modelPrefs.favorites.length === 0 && <span className="text-[10px] text-text-secondary/50">none yet — star a model</span>}
                {modelPrefs.favorites.map((m) => (
                  <span key={m} className="flex items-center gap-1 px-2 py-0.5 rounded border border-accent-amber/40 bg-accent-amber/10 text-[11px] text-accent-amber">
                    <button onClick={() => setAi({ ...ai, model: m })} className="hover:underline" title="Use this model">★ {m}</button>
                    <button onClick={() => setModelPrefs(toggleFavoriteModel(m))} className="opacity-60 hover:opacity-100" title="Unfavorite">×</button>
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-text-secondary">recents:</span>
                {modelPrefs.recents.length === 0 && <span className="text-[10px] text-text-secondary/50">none yet</span>}
                {modelPrefs.recents.map((m) => (
                  <button key={m} onClick={() => setAi({ ...ai, model: m })} className="px-2 py-0.5 rounded border border-border text-[11px] text-text-secondary hover:text-text-primary hover:border-text-secondary/40">
                    {m}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setModelPrefs(toggleFavoriteModel(ai.model))}
                className={`text-[11px] px-2 py-0.5 rounded border ${modelPrefs.favorites.includes(ai.model) ? 'text-accent-amber border-accent-amber/40' : 'text-text-secondary border-border hover:text-text-primary'}`}
              >
                {modelPrefs.favorites.includes(ai.model) ? '★ favorited' : '☆ add to favorites'}
              </button>
            </div>
            <div>
              <label className="text-xs text-text-secondary">API Key</label>
              {providerNeedsKey(ai.provider) ? (
                <>
                  <input
                    type="password"
                    value={ai.apiKey}
                    onChange={(e) => setAi({ ...ai, apiKey: e.target.value })}
                    placeholder={ai.apiKey ? 'saved for ' + ai.provider : 'paste your ' + ai.provider + ' key'}
                    className="w-full mt-1 px-2 py-1.5 bg-bg-tertiary border border-border rounded text-xs"
                  />
                  <div className="text-[10px] text-text-secondary/50 mt-1">Stored locally in your browser storage only. Never sent anywhere except the provider you chose. Keys are kept per provider.</div>
                </>
              ) : (
                <div className="mt-1 px-2 py-1.5 rounded border border-accent-green/30 bg-accent-green/5 text-[11px] text-accent-green">
                  No API key needed — {ai.provider} runs on your machine.
                  {providerInfo?.note && <span className="text-text-secondary"> ({providerInfo.note})</span>}
                </div>
              )}
            </div>
            <div>
              <label className="text-xs text-text-secondary">Cost estimate ($ per 1M tokens)</label>
              <input
                type="number"
                step="0.01"
                value={ai.pricePerMTok}
                onChange={(e) => setAi({ ...ai, pricePerMTok: parseFloat(e.target.value) || 0 })}
                className="w-full mt-1 px-2 py-1.5 bg-bg-tertiary border border-border rounded text-xs"
              />
            </div>
            <div className="flex items-center gap-2">
              <button onClick={saveAi} className="px-3 py-1.5 bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/40 rounded text-xs font-semibold">
                Save AI Settings
              </button>
              {aiSaved && <span className="text-xs text-accent-green">Saved ✓</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
