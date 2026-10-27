import { useState } from 'react';
import { callLLM } from '../lib/llm';
import type { Mission } from '../lib/missions';
import { AGENTS, type RunGroup, type Session } from '../lib/store';

interface RunCompareModalProps {
  group: RunGroup;
  mission: Mission | null;
  runs: Session[];
  runningIds: Set<string>;
  costPerM: number;
  onClose: () => void;
  onOpenRun: (id: string) => void;
  onPromote: (run: Session) => void;
  onFusion: (text: string) => void;
}

type RunStatus = 'running' | 'done' | 'failed' | 'waiting';

function statusOf(run: Session, busy: boolean): RunStatus {
  if (busy) return 'running';
  const last = run.messages[run.messages.length - 1];
  if (last?.role === 'error') return 'failed';
  if (run.messages.some((m) => m.role === 'assistant')) return 'done';
  return 'waiting';
}

const statusStyle: Record<RunStatus, string> = {
  running: 'text-accent-cyan',
  done: 'text-accent-green',
  failed: 'text-accent-red',
  waiting: 'text-text-muted',
};

const statusLabel: Record<RunStatus, string> = {
  running: '● running',
  done: '✓ done',
  failed: '✕ failed',
  waiting: '○ waiting',
};

function lastAssistant(run: Session): string {
  return [...run.messages].reverse().find((m) => m.role === 'assistant')?.text ?? '';
}

export default function RunCompareModal({
  group,
  mission,
  runs,
  runningIds,
  costPerM,
  onClose,
  onOpenRun,
  onPromote,
  onFusion,
}: RunCompareModalProps) {
  const [fusing, setFusing] = useState(false);
  const [fusionNote, setFusionNote] = useState('');

  const fusion = async () => {
    const usable = runs.filter((r) => lastAssistant(r).trim());
    if (usable.length < 2) {
      setFusionNote('Need at least two runs with replies to fuse.');
      return;
    }
    setFusing(true);
    setFusionNote('');
    try {
      const parts = usable
        .map((r, i) => {
          const u = r.usage;
          return `RUN ${i + 1} (${AGENTS[r.agent].name}${r.model ? ', ' + r.model : ''}${u ? `, ${u.total.toLocaleString()} tok` : ''}):\n${lastAssistant(r).slice(0, 4000)}`;
        })
        .join('\n\n---\n\n');
      const res = await callLLM([
        {
          role: 'system',
          content:
            'You merge parallel penetration-testing runs of the same prompt into one report. Keep only the strongest, verified findings and next steps; drop duplicates and weak guesses. Be concise and concrete. Reply with the merged report only.',
        },
        { role: 'user', content: `ORIGINAL PROMPT:\n${group.prompt}\n\nRUN RESULTS:\n${parts}` },
      ]);
      onFusion(`[fusion of ${usable.length} runs — ${group.name}]\n${res.content}`);
      setFusionNote('Fusion appended to the active session.');
    } catch (e) {
      setFusionNote(String(e));
    } finally {
      setFusing(false);
    }
  };

  const anyRunning = runs.some((r) => runningIds.has(r.id));

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-bg-elevated border border-border rounded-lg shadow-pop w-[900px] max-w-[95vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-11 border-b border-bordermuted flex items-center px-4 gap-2">
          <span className="font-medium text-sm">{group.name}</span>
          {mission && <span className="text-xs text-text-secondary">· {mission.name}</span>}
          <div className="flex-1" />
          <button
            onClick={fusion}
            disabled={fusing || anyRunning}
            className="px-2 py-1 text-xs border border-accent-purple/40 text-accent-purple rounded hover:bg-accent-purple/10 disabled:opacity-40"
            title="Merge the strongest outputs of all runs with one LLM call"
          >
            {fusing ? 'Fusing…' : '⚡ Fusion merge'}
          </button>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-sm px-1">
            ×
          </button>
        </div>

        {fusionNote && <div className="px-4 py-1 text-xs text-text-secondary border-b border-border">{fusionNote}</div>}

        <div className="p-4 overflow-y-auto grid grid-cols-1 lg:grid-cols-2 gap-3">
          {runs.length === 0 && (
            <div className="text-xs text-text-secondary italic col-span-2">
              No runs in this group (sessions may have been deleted).
            </div>
          )}
          {runs.map((run) => {
            const st = statusOf(run, runningIds.has(run.id));
            const u = run.usage;
            const snippet = lastAssistant(run);
            return (
              <div key={run.id} className="border border-border rounded-lg bg-bg-secondary p-3 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{run.name}</span>
                  <div className="flex-1" />
                  <span className={`text-[10px] ${statusStyle[st]}`}>{statusLabel[st]}</span>
                </div>
                <div className="text-[10px] text-text-secondary flex flex-wrap gap-x-3">
                  <span>agent: {AGENTS[run.agent].name}</span>
                  <span>model: {run.model ?? 'default'}</span>
                  <span>{run.messages.length} msgs</span>
                  {u && <span>{u.total.toLocaleString()} tok</span>}
                  {u && <span>${((u.total / 1_000_000) * costPerM).toFixed(4)}</span>}
                </div>
                <div className="text-xs text-text-secondary border border-border rounded p-2 flex-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono">
                  {snippet ? snippet.slice(0, 600) : '(no reply yet)'}
                  {snippet.length > 600 ? '…' : ''}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => onOpenRun(run.id)}
                    className="px-2 py-1 text-xs border border-border rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary"
                  >
                    Open
                  </button>
                  <button
                    onClick={() => onPromote(run)}
                    disabled={st !== 'done' && st !== 'running'}
                    className="px-2 py-1 text-xs border border-accent-cyan/40 text-accent-cyan rounded hover:bg-accent-cyan/10 disabled:opacity-40"
                    title="Copy this run's result into the active session"
                  >
                    Promote
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
