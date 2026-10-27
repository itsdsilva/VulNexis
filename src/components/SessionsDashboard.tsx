import type { Mission } from '../lib/missions';
import { AGENTS, type Session } from '../lib/store';

interface SessionsDashboardProps {
  sessions: Session[];
  missions: Mission[];
  runningIds: Set<string>;
  costPerM: number;
  onClose: () => void;
  onOpenSession: (id: string, missionId: string | null) => void;
}

type SessStatus = 'working' | 'waiting' | 'done' | 'failed' | 'blocked';

const GOAL_BLOCKED: string[] = ['blocked', 'budget'];

function statusOf(s: Session, busy: boolean): SessStatus {
  if (busy) return 'working';
  if (s.goal && GOAL_BLOCKED.includes(s.goal.state)) return 'blocked';
  const last = s.messages[s.messages.length - 1];
  if (last?.role === 'error') return 'failed';
  if (s.messages.some((m) => m.role === 'assistant')) return 'done';
  return 'waiting';
}

const statusStyle: Record<SessStatus, { dot: string; label: string }> = {
  working: { dot: 'text-accent-cyan animate-pulse', label: 'working' },
  waiting: { dot: 'text-text-muted', label: 'waiting' },
  done: { dot: 'text-accent-green', label: 'done' },
  failed: { dot: 'text-accent-red', label: 'failed' },
  blocked: { dot: 'text-accent-amber', label: 'blocked' },
};

export default function SessionsDashboard({
  sessions,
  missions,
  runningIds,
  costPerM,
  onClose,
  onOpenSession,
}: SessionsDashboardProps) {
  const missionName = (id: string | null) =>
    id ? missions.find((m) => m.id === id)?.name ?? '(deleted mission)' : 'General chat';

  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = s.missionId ?? '__chat__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  const totals = sessions.reduce(
    (acc, s) => {
      acc.tokens += s.usage?.total ?? 0;
      acc.calls += s.usage?.calls ?? 0;
      return acc;
    },
    { tokens: 0, calls: 0 }
  );

  const order = [...groups.keys()].sort((a, b) => {
    const ma = missions.findIndex((m) => m.id === a);
    const mb = missions.findIndex((m) => m.id === b);
    return (ma < 0 ? 999 : ma) - (mb < 0 ? 999 : mb);
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-bg-elevated border border-border rounded-lg shadow-pop w-[860px] max-w-[95vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-11 border-b border-bordermuted flex items-center px-4 gap-2">
          <span className="font-medium text-sm">Sessions Dashboard</span>
          <span className="text-xs text-text-secondary">
            {sessions.length} sessions · {totals.tokens.toLocaleString()} tok ·{' '}
            ${((totals.tokens / 1_000_000) * costPerM).toFixed(4)} · {totals.calls} calls
          </span>
          <div className="flex-1" />
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-sm px-1">
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {order.map((key) => (
            <div key={key}>
              <div className="text-xs uppercase tracking-wider text-text-secondary mb-1">
                {key === '__chat__' ? 'General chat' : missionName(key)}
              </div>
              <div className="space-y-1">
                {groups.get(key)!.map((s) => {
                  const st = statusOf(s, runningIds.has(s.id));
                  const u = s.usage;
                  return (
                    <button
                      key={s.id}
                      onClick={() => onOpenSession(s.id, s.missionId)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded border border-border bg-bg-secondary hover:bg-bg-tertiary text-left"
                    >
                      <span className={`text-xs ${statusStyle[st].dot}`}>●</span>
                      <span className="text-xs text-text-secondary w-16">{statusStyle[st].label}</span>
                      <span className="text-xs font-medium truncate flex-1">{s.name}</span>
                      {s.goal && (
                        <span
                          className={`text-[10px] px-1 py-0.5 rounded border ${
                            s.goal.state === 'complete'
                              ? 'border-accent-green/40 text-accent-green'
                              : s.goal.state === 'blocked' || s.goal.state === 'budget'
                                ? 'border-accent-red/40 text-accent-red'
                                : 'border-accent-cyan/40 text-accent-cyan'
                          }`}
                          title={`goal: ${s.goal.title}`}
                        >
                          ◎ {s.goal.state}
                        </span>
                      )}
                      {s.groupId && (
                        <span className="text-[10px] px-1 py-0.5 rounded border border-accent-purple/40 text-accent-purple">
                          multi-run
                        </span>
                      )}
                      <span className="text-[10px] text-text-secondary">{AGENTS[s.agent].name}</span>
                      <span className="text-[10px] text-text-muted w-40 truncate text-right">{s.model ?? 'default model'}</span>
                      <span className="text-[10px] text-text-secondary w-14 text-right">{s.messages.length} msgs</span>
                      <span className="text-[10px] text-text-secondary w-20 text-right">
                        {u ? `${u.total.toLocaleString()} tok` : '—'}
                      </span>
                      <span className="text-[10px] text-text-secondary w-16 text-right">
                        {u ? `$${((u.total / 1_000_000) * costPerM).toFixed(4)}` : '—'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {sessions.length === 0 && <div className="text-xs text-text-secondary italic">No sessions yet.</div>}
        </div>
      </div>
    </div>
  );
}
