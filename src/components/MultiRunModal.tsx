import { useState } from 'react';
import { PROVIDERS, loadModelPrefs, loadLLMSettings } from '../lib/llm';
import { AGENTS, type SessionAgent } from '../lib/store';

export interface RunSpec {
  agent: SessionAgent;
  model?: string;
  provider?: string;
  baseUrl?: string;
}

interface MultiRunModalProps {
  missionName: string;
  onClose: () => void;
  onLaunch: (name: string, prompt: string, runs: RunSpec[]) => void;
}

interface RowState {
  agent: SessionAgent;
  model: string;
  provider: string;
  custom: boolean;
}

const allModels = Object.entries(PROVIDERS).flatMap(([name, p]) =>
  p.models.map((m) => ({ model: m, provider: name, baseUrl: p.baseUrl }))
);

function rowFor(agent: SessionAgent, model = ''): RowState {
  if (!model) return { agent, model: '', provider: 'OpenRouter', custom: false };
  const owner = allModels.find((x) => x.model === model);
  return {
    agent,
    model,
    provider: owner?.provider ?? loadLLMSettings().provider,
    custom: !owner,
  };
}

export default function MultiRunModal({ missionName, onClose, onLaunch }: MultiRunModalProps) {
  const [name, setName] = useState(`Run group ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  const [prompt, setPrompt] = useState('');
  const prefs = loadModelPrefs();
  const [rows, setRows] = useState<RowState[]>([rowFor('recon'), rowFor('web')]);

  const setRow = (i: number, patch: Partial<RowState>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const launch = () => {
    const runs: RunSpec[] = rows.map((r) => {
      const owner = allModels.find((x) => x.model === r.model);
      return {
        agent: r.agent,
        model: r.model || undefined,
        provider: owner?.provider ?? r.provider,
        baseUrl: owner?.baseUrl ?? (r.model ? PROVIDERS[r.provider]?.baseUrl : undefined),
      };
    });
    onLaunch(name.trim() || 'Multi-run', prompt.trim(), runs);
  };

  const valid = prompt.trim().length > 0 && rows.length > 0;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-bg-primary border border-border rounded-lg w-[560px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-11 border-b border-border flex items-center px-4">
          <span className="font-medium text-sm">Multi-run — {missionName}</span>
          <div className="flex-1" />
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-sm px-1">
            ×
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          <div>
            <label className="text-xs text-text-secondary block mb-1">Run group name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">Prompt (sent to every run)</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="e.g. Enumerate the HTTP attack surface of *.example.com and report findings…"
              className="w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-sm resize-none"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-text-secondary">Runs ({rows.length}/5)</label>
              <button
                onClick={() => rows.length < 5 && setRows((rs) => [...rs, rowFor('pentest')])}
                disabled={rows.length >= 5}
                className="text-xs text-accent-cyan hover:text-accent-cyan/80 disabled:opacity-40"
              >
                + add run
              </button>
            </div>
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-[10px] text-text-muted w-4">{i + 1}.</span>
                <select
                  value={r.agent}
                  onChange={(e) => setRow(i, { agent: e.target.value as SessionAgent })}
                  className="bg-bg-tertiary border border-border rounded px-1 py-1 text-xs flex-1"
                  title={AGENTS[r.agent].description}
                >
                  {Object.entries(AGENTS).map(([id, a]) => (
                    <option key={id} value={id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <select
                  value={r.model}
                  onChange={(e) => setRow(i, rowFor(r.agent, e.target.value))}
                  className="bg-bg-tertiary border border-border rounded px-1 py-1 text-xs flex-1"
                  title="Model override (empty = app default)"
                >
                  <option value="">default model</option>
                  {prefs.favorites.map((m) => (
                    <option key={`fav-${m}`} value={m}>
                      ★ {m}
                    </option>
                  ))}
                  {allModels.map((x) => (
                    <option key={x.model} value={x.model}>
                      {x.model}
                    </option>
                  ))}
                </select>
                {rows.length > 1 && (
                  <button
                    onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                    className="text-text-secondary hover:text-accent-red text-sm px-1"
                    title="Remove run"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <div className="text-[10px] text-text-disabled">
              Each run becomes its own session in this mission, running in parallel with its agent focus and model.
            </div>
          </div>
        </div>

        <div className="h-14 border-t border-border flex items-center justify-end px-4">
          <button
            onClick={launch}
            disabled={!valid}
            className="px-4 py-1.5 bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/40 rounded text-sm hover:bg-accent-cyan/30 disabled:opacity-40"
          >
            Launch {rows.length} run{rows.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
