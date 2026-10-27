import { useState } from 'react';
import { AGENTS, loadTasks, saveTasks, type ScheduledTask } from '../lib/store';
import { type Mission } from '../lib/missions';

interface TasksModalProps {
  mission: Mission;
  onClose: () => void;
  onRunTask: (task: ScheduledTask) => Promise<string | null>; // returns error or null
  onOpenSession: (sessionId: string) => void;
  onTasksChanged: () => void;
}

export default function TasksModal({ mission, onClose, onRunTask, onOpenSession, onTasksChanged }: TasksModalProps) {
  const [tasks, setTasks] = useState<ScheduledTask[]>(() => loadTasks().filter((t) => t.missionId === mission.id));
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [type, setType] = useState<'daily' | 'weekly' | 'once'>('daily');
  const [time, setTime] = useState('09:00');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [date, setDate] = useState('');
  const [error, setError] = useState('');
  const [runningId, setRunningId] = useState<string | null>(null);

  const persist = (all: ScheduledTask[]) => {
    const others = loadTasks().filter((t) => t.missionId !== mission.id);
    saveTasks([...others, ...all]);
    setTasks(all);
    onTasksChanged();
  };

  const create = () => {
    if (!name.trim()) return setError('Give the task a name.');
    if (!prompt.trim()) return setError('Describe what the agent should do.');
    if (type === 'once' && !date) return setError('Pick a date for one-time tasks.');
    const task: ScheduledTask = {
      id: 't_' + Date.now().toString(36),
      missionId: mission.id,
      name: name.trim(),
      prompt: prompt.trim(),
      type,
      time,
      days: type === 'weekly' ? days : undefined,
      date: type === 'once' ? date : undefined,
      enabled: true,
    };
    persist([task, ...tasks]);
    setShowForm(false);
    setName('');
    setPrompt('');
    setError('');
  };

  const toggle = (id: string) => {
    persist(tasks.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t)));
  };

  const remove = (id: string) => {
    persist(tasks.filter((t) => t.id !== id));
  };

  const runNow = async (t: ScheduledTask) => {
    setRunningId(t.id);
    const err = await onRunTask({ ...t, enabled: true });
    setRunningId(null);
    if (err) setError(err);
    else {
      const updated = loadTasks().filter((x) => x.missionId === mission.id);
      setTasks(updated);
      onTasksChanged();
    }
  };

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const describe = (t: ScheduledTask) => {
    if (t.type === 'daily') return `Daily at ${t.time}`;
    if (t.type === 'once') return `Once on ${t.date}`;
    return `Weekly at ${t.time} on ${(t.days || []).map((d) => dayNames[d]).join(', ')}`;
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="w-[620px] max-h-[85vh] overflow-y-auto bg-bg-elevated border border-border rounded-lg shadow-pop">
        <div className="h-10 border-b border-bordermuted flex items-center justify-between px-4">
          <span className="text-sm font-semibold">Scheduled Tasks — {mission.name}</span>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-base">×</button>
        </div>

        <div className="p-4 space-y-3">
          {!showForm && (
            <button
              onClick={() => setShowForm(true)}
              className="px-3 py-1.5 bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/30 rounded text-xs"
            >
              + New Task
            </button>
          )}

          {showForm && (
            <div className="space-y-2 border border-border rounded p-3">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Task name (e.g. Daily recon sweep)"
                className="w-full px-2 py-1.5 bg-bg-tertiary border border-border rounded text-xs" />
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
                placeholder="Prompt for the agent, e.g. 'Run a recon sweep on the in-scope targets and report anything new.'"
                className="w-full px-2 py-1.5 bg-bg-tertiary border border-border rounded text-xs" />
              <div className="grid grid-cols-3 gap-2">
                <select value={type} onChange={(e) => setType(e.target.value as any)}
                  className="px-2 py-1.5 bg-bg-tertiary border border-border rounded text-xs">
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="once">Once</option>
                </select>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
                  className="px-2 py-1.5 bg-bg-tertiary border border-border rounded text-xs" />
                {type === 'once' ? (
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                    className="px-2 py-1.5 bg-bg-tertiary border border-border rounded text-xs" />
                ) : (
                  <div className="text-[10px] text-text-secondary/60 self-center">Runs in-app only (VulNexis must be open)</div>
                )}
              </div>
              {type === 'weekly' && (
                <div className="flex gap-1">
                  {dayNames.map((d, i) => (
                    <button key={d}
                      onClick={() => setDays((ds) => (ds.includes(i) ? ds.filter((x) => x !== i) : [...ds, i]))}
                      className={`px-2 py-0.5 rounded text-[10px] border ${
                        days.includes(i) ? 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30' : 'text-text-secondary border-border'
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              )}
              {error && <div className="text-xs text-accent-red">{error}</div>}
              <div className="flex gap-2">
                <button onClick={create} className="px-3 py-1.5 bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/40 rounded text-xs font-semibold">
                  Create Task
                </button>
                <button onClick={() => { setShowForm(false); setError(''); }} className="px-3 py-1.5 text-text-secondary border border-border rounded text-xs">
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            {tasks.length === 0 && <div className="text-xs text-text-secondary/50 italic">No tasks yet. Create one to automate recurring recon.</div>}
            {tasks.map((t) => (
              <div key={t.id} className="border border-border rounded p-3 space-y-1">
                <div className="flex items-center gap-2">
                  <button onClick={() => toggle(t.id)}
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${t.enabled ? 'bg-accent-green/10 text-accent-green border-accent-green/30' : 'text-text-secondary border-border'}`}>
                    {t.enabled ? 'enabled' : 'paused'}
                  </button>
                  <span className="text-xs font-medium flex-1 truncate">{t.name}</span>
                  <button onClick={() => runNow(t)} disabled={runningId === t.id}
                    className="text-[10px] px-2 py-0.5 text-accent-cyan border border-accent-cyan/30 rounded hover:bg-accent-cyan/10 disabled:opacity-40">
                    {runningId === t.id ? 'running…' : 'Run now'}
                  </button>
                  <button onClick={() => remove(t.id)} className="text-text-secondary hover:text-accent-red text-xs">×</button>
                </div>
                <div className="text-[10px] text-text-secondary">{describe(t)}</div>
                <div className="text-[11px] text-text-secondary/80 truncate">{t.prompt}</div>
                {t.sessionId && (
                  <button onClick={() => onOpenSession(t.sessionId!)} className="text-[10px] text-accent-purple hover:underline">
                    open last session →
                  </button>
                )}
                {t.lastRun && <div className="text-[10px] text-text-secondary/50">Last run: {new Date(t.lastRun).toLocaleString()}</div>}
                <div className="text-[10px] text-text-secondary/50">Agent: {AGENTS.recon.name} (low-risk auto-run)</div>
              </div>
            ))}
          </div>

          {error && !showForm && <div className="text-xs text-accent-red">{error}</div>}
        </div>
      </div>
    </div>
  );
}
