import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isInScope, type Mission } from '../lib/missions';
import { inTauri } from '../lib/llm';
import { sshExec } from '../lib/ssh';

interface BrowserPanelProps {
  mission: Mission;
  suggestedUrls?: string[];
}

interface FetchResult {
  status: number;
  headers: [string, string][];
  body: string;
  final_url: string;
}

export default function BrowserPanel({ mission, suggestedUrls = [] }: BrowserPanelProps) {
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState('GET');
  const [result, setResult] = useState<FetchResult | null>(null);
  const [curlOut, setCurlOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const send = async () => {
    setError('');
    setCurlOut('');
    setResult(null);
    let host = '';
    try {
      const u = new URL(url);
      host = u.hostname;
    } catch {
      setError('Invalid URL');
      return;
    }
    if (!isInScope(host, mission.scope)) {
      setError(`Blocked: "${host}" is not in this mission's scope. Add it to the mission first.`);
      return;
    }
    setBusy(true);
    try {
      if (!inTauri()) {
        throw new Error('HTTP requests require the desktop app — run "npm run tauri dev" or launch the installed VulNexis.');
      }
      const r = await invoke<FetchResult>('http_fetch', { req: { url, method } });
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const viaKali = async () => {
    setError('');
    setCurlOut('');
    try {
      const out = await sshExec(`curl -sS -i --max-time 20 ${JSON.stringify(url)} | head -c 20000`);
      setCurlOut(out);
    } catch (e) {
      setError(String(e));
    }
  };

  const statusColor = (s: number) =>
    s >= 500 ? 'text-accent-red' : s >= 400 ? 'text-accent-amber' : s >= 300 ? 'text-accent-purple' : 'text-accent-green';

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        <select value={method} onChange={(e) => setMethod(e.target.value)}
          className="px-1 py-1 bg-bg-tertiary border border-border rounded text-[10px]">
          {['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={`http://<in-scope-target>/path`}
          className="flex-1 px-2 py-1 bg-bg-tertiary border border-border rounded text-xs font-mono"
        />
        <button onClick={send} disabled={busy || !url}
          className="px-2 py-1 bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/30 rounded text-xs disabled:opacity-40">
          {busy ? '…' : 'Send'}
        </button>
      </div>

      {url && (
        <button onClick={viaKali} className="text-[10px] text-text-secondary hover:text-accent-cyan">
          also fetch via Kali (curl -i) →
        </button>
      )}

      {error && <div className="text-[11px] text-accent-red">{error}</div>}

      {suggestedUrls.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {suggestedUrls
            .filter((u) => isInScope(new URL(u).hostname, mission.scope))
            .slice(0, 8)
            .map((u) => (
              <button
                key={u}
                onClick={() => setUrl(u)}
                className="max-w-[150px] truncate px-1.5 py-0.5 rounded border border-border text-[10px] font-mono text-text-secondary hover:text-accent-cyan hover:border-accent-cyan/40"
                title={u}
              >
                {u}
              </button>
            ))}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span className={`font-mono font-semibold ${statusColor(result.status)}`}>{result.status}</span>
            <span className="text-text-secondary font-mono text-[10px] truncate">{result.final_url}</span>
          </div>
          <div className="bg-bg-tertiary border border-border rounded p-2 max-h-32 overflow-y-auto">
            {result.headers.map(([k, v], i) => (
              <div key={i} className="text-[10px] font-mono">
                <span className="text-accent-cyan">{k}:</span> <span className="text-text-secondary">{v}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="text-[10px] text-text-secondary mb-1">Body ({result.body.length.toLocaleString()} bytes)</div>
            <pre className="bg-black border border-border rounded p-2 text-[10px] font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">
              {result.body}
            </pre>
          </div>
        </div>
      )}

      {curlOut && (
        <div>
          <div className="text-[10px] text-text-secondary mb-1">Kali curl output</div>
          <pre className="bg-black border border-border rounded p-2 text-[10px] font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
            {curlOut}
          </pre>
        </div>
      )}
    </div>
  );
}
