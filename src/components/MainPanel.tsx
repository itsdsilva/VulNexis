import { useEffect, useRef, useState } from 'react';
import Markdown from './Markdown';
import type { Mission } from '../lib/missions';
import { forkSession, type GoalState, type PermissionMode, type Session, type SessionGoal } from '../lib/store';
import { saveLLMSettings, loadLLMSettings, loadModelPrefs, rememberRecentModel, toggleFavoriteModel, PROVIDERS, type LLMSettings, type ModelPrefs } from '../lib/llm';
import { WORKFLOWS, runWorkflow } from '../lib/workflows';
import { runTurn, runGoalLoop } from '../lib/agent';

interface MainPanelProps {
  mission: Mission | null;
  session: Session | null;
  connected: boolean;
  permissionMode: PermissionMode;
  budgetTokens: number;
  usageTotal: number;
  onPermissionChange: (m: PermissionMode) => void;
  onBudgetChange: (v: number) => void;
  onUsage: (u: { prompt: number; completion: number; total: number; calls: number }) => void;
  onUpdateSession: (s: Session) => void;
  onFork: (s: Session) => void;
  onNewMission: () => void;
  onOpenMultiRun: () => void;
  onOpenPlaybook: () => void;
}

const agentBadge: Record<string, string> = {
  pentest: 'bg-accent-cyan/10 text-accent-cyan',
  recon: 'bg-accent-green/10 text-accent-green',
  web: 'bg-accent-purple/10 text-accent-purple',
  privesc: 'bg-accent-amber/10 text-accent-amber',
  expl: 'bg-accent-red/10 text-accent-red',
  replan: 'bg-accent-purple/10 text-accent-purple',
};

const GOAL_TERMINAL: GoalState[] = ['complete', 'blocked', 'budget'];

const goalStateStyle: Record<GoalState, { dot: string; chip: string; label: string }> = {
  pending: { dot: 'text-accent-amber', chip: 'border-accent-amber/40 text-accent-amber', label: 'ready' },
  running: { dot: 'text-accent-cyan animate-pulse', chip: 'border-accent-cyan/40 text-accent-cyan', label: 'running' },
  complete: { dot: 'text-accent-green', chip: 'border-accent-green/40 text-accent-green', label: 'complete' },
  blocked: { dot: 'text-accent-red', chip: 'border-accent-red/40 text-accent-red', label: 'blocked' },
  budget: { dot: 'text-accent-red', chip: 'border-accent-red/40 text-accent-red', label: 'budget reached' },
};

function roleStyle(role: string) {
  switch (role) {
    case 'user':
      return 'border-accent-cyan/20 bg-accent-cyan/[0.06]';
    case 'assistant':
      return 'border-bordermuted bg-bg-secondary';
    case 'tool':
      return 'border-bordermuted bg-bg-tertiary/70 font-mono text-xs';
    case 'error':
      return 'border-accent-red/30 bg-accent-red/[0.06] text-accent-red';
    default:
      return 'border-bordermuted bg-bg-secondary';
  }
}

interface GoalForm {
  title: string;
  criteria: string;
  maxTurns: number;
  budget: number;
}

function formOf(goal: SessionGoal): GoalForm {
  return { title: goal.title, criteria: goal.criteria, maxTurns: goal.maxTurns, budget: goal.budget };
}

export default function MainPanel({
  mission,
  session,
  connected,
  permissionMode,
  budgetTokens,
  usageTotal,
  onPermissionChange,
  onBudgetChange,
  onUsage,
  onUpdateSession,
  onFork,
  onNewMission,
  onOpenMultiRun,
  onOpenPlaybook,
}: MainPanelProps) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'turn' | 'eval'>('idle');
  const [showSettings, setShowSettings] = useState(false);
  const [permission, setPermission] = useState<PermissionMode>('ask');
  const [budget, setBudget] = useState<number>(budgetTokens);
  const [modelOpen, setModelOpen] = useState(false);
  const [llm, setLlm] = useState<LLMSettings>(() => loadLLMSettings());
  const [prefs, setPrefs] = useState<ModelPrefs>(() => loadModelPrefs());
  const [goalDialog, setGoalDialog] = useState(false);
  const [goalArmed, setGoalArmed] = useState(false);
  const [goalForm, setGoalForm] = useState<GoalForm>({ title: '', criteria: '', maxTurns: 8, budget: 0 });
  const pauseRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPermission(permissionMode);
  }, [permissionMode]);
  useEffect(() => {
    setBudget(budgetTokens);
  }, [budgetTokens]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session?.messages.length, session?.messages[session.messages.length - 1]?.text.length]);

  // Reload model settings when they're saved anywhere (Settings modal, picker).
  useEffect(() => {
    const reload = () => {
      setLlm(loadLLMSettings());
      setPrefs(loadModelPrefs());
    };
    window.addEventListener('vulnexis:llm-settings', reload);
    return () => window.removeEventListener('vulnexis:llm-settings', reload);
  }, []);

  const goal = session?.goal;
  const goalActive = !!goal && !GOAL_TERMINAL.includes(goal.state);

  const startGoalLoop = async (sessionAtStart: Session) => {
    setBusy(true);
    setPhase('eval');
    try {
      await runGoalLoop(mission, sessionAtStart, {
        connected,
        permission,
        budget,
        usageTotal,
        shouldStop: () => pauseRef.current,
        onUpdate: onUpdateSession,
        onUsage,
      });
    } finally {
      setBusy(false);
      setPhase('idle');
      pauseRef.current = false;
    }
  };

  const send = async () => {
    if (!input.trim() || busy || !session) return;
    const text = input.trim();
    let start = session;

    // Goal armed in the composer: this message becomes the objective
    if (goalArmed) {
      if (goalActive) {
        setGoalArmed(false);
      } else {
        const newGoal: SessionGoal = {
          title: goalForm.title.trim() || text.split('\n')[0].slice(0, 60),
          criteria: goalForm.criteria.trim() || text,
          state: 'pending',
          note: '',
          turns: 0,
          maxTurns: Math.max(1, goalForm.maxTurns),
          budget: Math.max(0, goalForm.budget),
          blockedStreak: 0,
          createdAt: new Date().toISOString(),
        };
        start = { ...session, goal: newGoal, updatedAt: new Date().toISOString() };
        onUpdateSession(start);
        setGoalArmed(false);
      }
    }

    setInput('');
    setBusy(true);
    setPhase('turn');
    try {
      const after = await runTurn(mission, start, text, {
        connected,
        permission,
        budget,
        usageTotal,
        onUpdate: onUpdateSession,
        onUsage,
        onFork,
      });
      if (after.goal && !GOAL_TERMINAL.includes(after.goal.state)) {
        await startGoalLoop(after);
      }
    } finally {
      setBusy(false);
      setPhase('idle');
      pauseRef.current = false;
    }
  };

  const runWorkflowById = async (id: string) => {
    const wf = WORKFLOWS.find((w) => w.id === id);
    if (!wf || busy || !session || !mission) return;
    setBusy(true);
    try {
      const updated = await runWorkflow(mission, session, wf, {
        connected,
        onUpdate: onUpdateSession,
        withAnalysis: true,
      });
      onUpdateSession(updated);
    } finally {
      setBusy(false);
    }
  };

  const toggleModelOpen = () => {
    if (!modelOpen) {
      setLlm(loadLLMSettings());
      setPrefs(loadModelPrefs());
    }
    setModelOpen(!modelOpen);
  };

  const pickModel = (m: string) => {
    const cur = loadLLMSettings();
    // Switch the provider along with the model so the baseUrl always matches
    const owner = Object.entries(PROVIDERS).find(([, p]) => p.models.includes(m));
    const next = owner
      ? { ...cur, provider: owner[0], baseUrl: owner[1].baseUrl, model: m }
      : { ...cur, model: m };
    saveLLMSettings(next);
    setLlm(next);
    setPrefs(rememberRecentModel(m));
    setModelOpen(false);
  };

  const openGoalDialog = () => {
    setGoalForm(goal ? formOf(goal) : { title: '', criteria: '', maxTurns: 8, budget: 0 });
    setGoalDialog(true);
  };

  const saveGoalForm = () => {
    if (!session || !goal) return;
    const next: SessionGoal = {
      ...goal,
      title: goalForm.title.trim() || goal.title,
      criteria: goalForm.criteria.trim() || goal.criteria,
      maxTurns: Math.max(1, goalForm.maxTurns),
      budget: Math.max(0, goalForm.budget),
    };
    onUpdateSession({ ...session, goal: next, updatedAt: new Date().toISOString() });
    setGoalDialog(false);
  };

  const startGoalNow = async () => {
    if (!session || busy) return;
    const newGoal: SessionGoal = {
      title: goalForm.title.trim() || goalForm.criteria.split('\n')[0].slice(0, 60) || 'Untitled goal',
      criteria: goalForm.criteria.trim(),
      state: 'pending',
      note: '',
      turns: 0,
      maxTurns: Math.max(1, goalForm.maxTurns),
      budget: Math.max(0, goalForm.budget),
      blockedStreak: 0,
      createdAt: new Date().toISOString(),
    };
    if (!newGoal.criteria) return;
    const start = { ...session, goal: newGoal, updatedAt: new Date().toISOString() };
    onUpdateSession(start);
    setGoalDialog(false);
    pauseRef.current = false;
    await startGoalLoop(start);
  };

  const pauseGoal = () => {
    pauseRef.current = true;
    if (session?.goal) {
      onUpdateSession({
        ...session,
        goal: { ...session.goal, state: 'pending', note: 'Paused — resume to continue.' },
        updatedAt: new Date().toISOString(),
      });
    }
  };

  const resumeGoal = async () => {
    if (!session?.goal || busy) return;
    pauseRef.current = false;
    await startGoalLoop(session);
  };

  const clearGoal = () => {
    if (!session) return;
    onUpdateSession({ ...session, goal: undefined, updatedAt: new Date().toISOString() });
    setGoalDialog(false);
    setGoalArmed(false);
  };

  const providerInfo = PROVIDERS[llm.provider];

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Session header */}
      <div className="h-11 border-b border-bordermuted flex items-center px-4 gap-2 shrink-0 bg-bg-secondary/50">
        <span className="text-sm font-medium truncate">{session?.name ?? 'New chat'}</span>
        {session && session.agent !== 'recon' && (
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${agentBadge[session.agent] ?? 'bg-bg-tertiary text-text-secondary border border-bordermuted'}`}>
            {session.agent}
          </span>
        )}
        {!mission && <span className="chip !py-0">chat</span>}
        {mission && (
          <span className="chip !py-0 border-accent-cyan/25 text-accent-cyan">
            {mission.name}
          </span>
        )}
        {session?.groupId && (
          <span className="chip !py-0 border-accent-purple/25 text-accent-purple">multi-run</span>
        )}
        <div className="flex-1" />
        {session && (
          <button
            onClick={() => onFork(forkSession(session))}
            className="text-xs text-text-secondary hover:text-accent-purple px-2 py-1 rounded-full hover:bg-bg-tertiary"
            title="Fork this session — copy history into a new session"
          >
            fork
          </button>
        )}
        {mission && (
          <button
            onClick={onOpenMultiRun}
            className="text-xs text-text-secondary hover:text-accent-purple px-2 py-1 rounded-full hover:bg-bg-tertiary"
            title="Run the same prompt across several parallel sessions"
          >
            multi-run
          </button>
        )}
        {mission && (
          <button
            onClick={onOpenPlaybook}
            className="text-xs text-text-secondary hover:text-accent-purple px-2 py-1 rounded-full hover:bg-bg-tertiary"
            title="Run a pentest-ai playbook — phase-by-phase with manual gates"
          >
            playbook
          </button>
        )}
        {mission && (
          <div className="flex items-center gap-1.5 text-xs">
            <select
              value={permission}
              onChange={(e) => onPermissionChange(e.target.value as PermissionMode)}
              className="bg-bg-tertiary border border-bordermuted rounded-full px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary cursor-pointer"
            >
              <option value="ask">ask every command</option>
              <option value="auto-low">auto-run low risk</option>
              <option value="full">full autopilot</option>
            </select>
            <button
              onClick={() => setShowSettings((v) => !v)}
              className={`text-[11px] px-2 py-1 rounded-full border ${showSettings ? 'border-border text-text-primary bg-bg-tertiary' : 'border-bordermuted text-text-secondary hover:text-text-primary'}`}
              title="Token budget settings"
            >
              budget
            </button>
          </div>
        )}
      </div>

      {mission && showSettings && (
        <div className="border-b border-bordermuted bg-bg-secondary/70 px-4 py-3 flex items-center gap-3 text-xs shrink-0">
          <label className="text-text-secondary">Auto-stop after:</label>
          <input
            type="number"
            min={0}
            step={10000}
            value={budget}
            onChange={(e) => {
              const v = Number(e.target.value) || 0;
              setBudget(v);
              onBudgetChange(v);
            }}
            className="bg-bg-tertiary border border-bordermuted rounded-md px-2 py-1 w-32 focus:border-accent-cyan/50"
          />
          <span className="text-text-secondary">tokens (0 = no limit)</span>
          <div className="flex-1" />
          <span className="text-text-secondary">
            used this mission: <span className="text-text-primary font-mono">{usageTotal.toLocaleString()}</span>
          </span>
        </div>
      )}

      {/* Goal strip */}
      {goal && (
        <div className="border-b border-bordermuted bg-bg-secondary/70 px-4 py-2 flex items-center gap-2 text-xs shrink-0">
          <span className={goalStateStyle[goal.state].dot}>◎</span>
          <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${goalStateStyle[goal.state].chip}`}>
            {goalStateStyle[goal.state].label}
          </span>
          <span className="font-medium truncate max-w-[180px]" title={goal.title}>
            {goal.title}
          </span>
          {busy && phase === 'eval' && goal.state === 'running' && (
            <span className="text-accent-cyan animate-pulse">evaluating…</span>
          )}
          <span className="text-text-muted truncate flex-1" title={goal.note}>
            {goal.note || '—'}
          </span>
          <span className="text-text-muted whitespace-nowrap font-mono text-[10px]">
            turn {goal.turns}/{goal.maxTurns}
          </span>
          {goalActive && (
            <button
              onClick={pauseGoal}
              className="text-text-secondary hover:text-text-primary px-1.5 py-0.5 rounded hover:bg-bg-tertiary"
              title="Pause the goal loop and stop after the current turn"
            >
              pause
            </button>
          )}
          {goal.state === 'pending' && (
            <button
              onClick={resumeGoal}
              disabled={busy}
              className="text-accent-cyan hover:text-accent-cyan/80 px-1.5 py-0.5 rounded hover:bg-bg-tertiary disabled:opacity-40"
              title="Resume — re-run the goal loop now"
            >
              resume
            </button>
          )}
          <button onClick={openGoalDialog} className="text-text-secondary hover:text-text-primary px-1.5 py-0.5 rounded hover:bg-bg-tertiary" title="Edit, remove or review the goal">
            edit
          </button>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5">
        <div className="max-w-3xl mx-auto space-y-3">
          {session?.messages.length === 0 && (
            <div className="text-text-muted text-sm italic px-2 pt-8 text-center">
              {mission
                ? `Mission "${mission.name}" is active. Describe what you want to test, paste scan output, or ask for a plan.`
                : 'Ask anything — this is a plain AI chat. Create a mission to let the agent run tools on your Kali VM.'}
            </div>
          )}
          {session?.messages.map((m, i) => (
            <div key={i} className={`border rounded-xl px-4 py-3 text-sm shadow-card ${roleStyle(m.role)}`}>
              {m.role === 'tool' && <div className="text-[9px] text-accent-green/80 mb-1.5 micro-label !text-accent-green/70">tool output</div>}
              {m.role === 'error' && <div className="text-[9px] text-accent-red/80 mb-1.5 micro-label !text-accent-red/70">error</div>}
              {m.role === 'assistant' ? (
                <Markdown text={m.text} />
              ) : (
                <div className="whitespace-pre-wrap break-words">{m.text}</div>
              )}
            </div>
          ))}
          {busy && phase === 'turn' && <div className="text-text-muted text-sm italic px-2 animate-pulse">thinking…</div>}
          {busy && phase === 'eval' && (
            <div className="text-accent-cyan text-sm italic px-2 animate-pulse">goal loop running — auditing progress…</div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="p-3 border-t border-bordermuted shrink-0 relative bg-bg-secondary/40">
        {mission && (
          <div className="flex items-center gap-2 pb-2 text-xs">
            <span className="micro-label">workflows</span>
            {WORKFLOWS.map((w) => (
              <button
                key={w.id}
                onClick={() => runWorkflowById(w.id)}
                disabled={!connected || busy}
                title={w.description}
                className="px-2.5 py-1 rounded-full border border-bordermuted bg-bg-tertiary/60 text-[11px] text-text-secondary hover:text-accent-cyan hover:border-accent-cyan/40 disabled:opacity-40"
              >
                {w.name}
              </button>
            ))}
          </div>
        )}
        {goalArmed && (
          <div className="flex items-center gap-2 pb-2 text-xs">
            <span className="text-accent-amber">◎ goal armed</span>
            <span className="text-text-muted">your next message becomes the goal objective</span>
            <button onClick={() => setGoalArmed(false)} className="text-text-secondary hover:text-text-primary">
              cancel
            </button>
          </div>
        )}
        <div className="card !bg-bg-tertiary/80 flex items-end gap-2 px-3 py-2 focus-within:border-accent-cyan/40 focus-within:shadow-glow transition-all">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              mission
                ? connected
                  ? 'Describe the objective, paste output, or give feedback…'
                  : 'Chat freely — connect to Kali in Settings to run commands…'
                : 'Ask anything…'
            }
            disabled={busy}
            rows={2}
            className="flex-1 bg-transparent border-0 px-0 py-1 text-sm resize-none focus:outline-none focus:ring-0 disabled:opacity-50 placeholder:text-text-disabled"
          />
          <button
            onClick={send}
            disabled={busy || !input.trim()}
            className="px-4 py-1.5 btn-primary text-xs self-end disabled:!opacity-40"
          >
            Send
          </button>
        </div>
        {/* Model picker — in the composer */}
        <div className="flex items-center gap-2 pt-2 text-xs">
          <button
            onClick={toggleModelOpen}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-bordermuted bg-bg-tertiary/60 text-text-secondary hover:text-text-primary hover:border-border"
          >
            <span className="text-text-muted">model:</span>
            <span className="text-text-primary font-mono text-[11px]">{llm.model}</span>
            <span className="text-text-muted">{modelOpen ? '▴' : '▾'}</span>
          </button>
          {/* Goal target button: armed amber, blue while running, green complete, red blocked */}
          <button
            onClick={() => {
              if (goal) openGoalDialog();
              else {
                setGoalForm({ title: '', criteria: '', maxTurns: 8, budget: 0 });
                setGoalDialog(true);
              }
            }}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-full border bg-bg-tertiary/60 ${
              goalActive
                ? 'border-accent-cyan/50 text-accent-cyan'
                : goal?.state === 'complete'
                  ? 'border-accent-green/50 text-accent-green'
                  : goal?.state === 'blocked' || goal?.state === 'budget'
                    ? 'border-accent-red/50 text-accent-red'
                    : goalArmed
                      ? 'border-accent-amber/50 text-accent-amber'
                      : 'border-bordermuted text-text-secondary hover:text-text-primary hover:border-border'
            }`}
            title={goal ? 'Goal settings' : 'Set a goal — the agent keeps working toward it automatically'}
          >
            <span>◎</span>
            <span>{goal ? 'goal' : 'set goal'}</span>
          </button>
          {!mission && (
            <button
              onClick={onNewMission}
              className="px-2.5 py-1 rounded-full border border-bordermuted bg-bg-tertiary/60 text-text-secondary hover:text-accent-cyan hover:border-accent-cyan/40"
            >
              + new mission
            </button>
          )}
        </div>

        {modelOpen && (
          <div className="absolute bottom-full left-3 right-3 mb-2 bg-bg-secondary border border-bordermuted rounded-xl shadow-pop z-40 max-h-80 overflow-y-auto">
            <div className="p-3 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="micro-label w-16">favorites</span>
                {prefs.favorites.length === 0 && <span className="text-[11px] text-text-disabled">none yet — star a model below</span>}
                {prefs.favorites.map((m) => (
                  <span key={m} className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-accent-amber/30 bg-accent-amber/10 text-[11px] text-accent-amber">
                    <button onClick={() => pickModel(m)} className="font-mono">★ {m}</button>
                    <button onClick={() => setPrefs(toggleFavoriteModel(m))} className="opacity-60 hover:opacity-100">×</button>
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="micro-label w-16">recent</span>
                {prefs.recents.length === 0 && <span className="text-[11px] text-text-disabled">none yet</span>}
                {prefs.recents.map((m) => (
                  <button key={m} onClick={() => pickModel(m)} className="px-2.5 py-1 rounded-full border border-bordermuted bg-bg-tertiary/60 text-[11px] font-mono text-text-secondary hover:text-text-primary hover:border-border">
                    {m}
                  </button>
                ))}
              </div>
              <div className="border-t border-bordermuted pt-2 space-y-1">
                {Object.entries(PROVIDERS).map(([name, p]) => (
                  <div key={name}>
                    <div className="micro-label py-1">{name}</div>
                    {p.models.map((m) => (
                      <div key={m} className="flex items-center group">
                        <button
                          onClick={() => pickModel(m)}
                          className={`flex-1 text-left px-2 py-1 rounded-md text-[11px] font-mono hover:bg-bg-tertiary ${m === llm.model ? 'text-accent-cyan' : 'text-text-secondary'}`}
                        >
                          {m}
                        </button>
                        <button
                          onClick={() => setPrefs(toggleFavoriteModel(m))}
                          className={`px-2 text-xs ${prefs.favorites.includes(m) ? 'text-accent-amber' : 'text-text-disabled opacity-0 group-hover:opacity-100'}`}
                          title="Toggle favorite"
                        >
                          {prefs.favorites.includes(m) ? '★' : '☆'}
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <div className="text-[10px] text-text-disabled border-t border-bordermuted pt-2">
                provider: {llm.provider} · key: {llm.apiKey ? 'configured' : 'missing (set in Settings → AI Model)'}
                {providerInfo && !providerInfo.models.includes(llm.model) && ' · custom model'}
              </div>
            </div>
          </div>
        )}

        {/* Goal dialog */}
        {goalDialog && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setGoalDialog(false)}>
            <div
              className="bg-bg-secondary border border-bordermuted rounded-xl shadow-pop w-[480px] max-h-[85vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="h-11 border-b border-bordermuted flex items-center px-4">
                <span className="font-medium text-sm">{goal ? 'Goal' : 'Set a goal'}</span>
                <div className="flex-1" />
                <button onClick={() => setGoalDialog(false)} className="text-text-muted hover:text-text-primary text-sm px-1">
                  ×
                </button>
              </div>
              <div className="p-4 space-y-3 overflow-y-auto">
                <div>
                  <label className="text-xs text-text-secondary block mb-1">Title</label>
                  <input
                    value={goalForm.title}
                    onChange={(e) => setGoalForm((f) => ({ ...f, title: e.target.value }))}
                    disabled={!!goal && GOAL_TERMINAL.includes(goal.state)}
                    placeholder="e.g. Map the web attack surface"
                    className="w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-text-secondary block mb-1">Completion criteria (self-contained)</label>
                  <textarea
                    value={goalForm.criteria}
                    onChange={(e) => setGoalForm((f) => ({ ...f, criteria: e.target.value }))}
                    disabled={!!goal && GOAL_TERMINAL.includes(goal.state)}
                    rows={4}
                    placeholder="Describe the finished state so an auditor without chat history can verify it. e.g. Enumerate subdomains and open ports for all in-scope targets, then summarize findings with evidence."
                    className="w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-sm resize-none"
                  />
                </div>
                <div className="flex gap-4">
                  <div>
                    <label className="text-xs text-text-secondary block mb-1">Max auto-turns</label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={goalForm.maxTurns}
                      onChange={(e) => setGoalForm((f) => ({ ...f, maxTurns: Number(e.target.value) || 8 }))}
                      disabled={!!goal && GOAL_TERMINAL.includes(goal.state)}
                      className="w-24 bg-bg-tertiary border border-border rounded px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-text-secondary block mb-1">Token budget (0 = none)</label>
                    <input
                      type="number"
                      min={0}
                      step={10000}
                      value={goalForm.budget}
                      onChange={(e) => setGoalForm((f) => ({ ...f, budget: Number(e.target.value) || 0 }))}
                      disabled={!!goal && GOAL_TERMINAL.includes(goal.state)}
                      className="w-32 bg-bg-tertiary border border-border rounded px-2 py-1.5 text-sm"
                    />
                  </div>
                </div>
                {goal && (
                  <div className="text-[10px] text-text-muted border border-border rounded px-2 py-1.5">
                    state: {goal.state} · turns used: {goal.turns}/{goal.maxTurns}
                    {goal.note ? ` · last note: ${goal.note}` : ''}
                    {GOAL_TERMINAL.includes(goal.state) && ' · finished — read-only'}
                  </div>
                )}
              </div>
              <div className="p-4 pt-0 flex gap-2 flex-wrap">
                {!goal && (
                  <>
                    <button
                      onClick={startGoalNow}
                      disabled={!goalForm.criteria.trim() || busy}
                      className="px-3 py-1.5 bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/40 rounded text-sm hover:bg-accent-cyan/30 disabled:opacity-40"
                    >
                      Start now
                    </button>
                    <button
                      onClick={() => {
                        setGoalArmed(true);
                        setGoalDialog(false);
                      }}
                      className="px-3 py-1.5 border border-accent-amber/40 text-accent-amber rounded text-sm hover:bg-accent-amber/10"
                      title="Arm the goal; your next message becomes the objective"
                    >
                      Arm next message
                    </button>
                  </>
                )}
                {goal && goal.state === 'pending' && (
                  <button
                    onClick={resumeGoal}
                    disabled={busy}
                    className="px-3 py-1.5 bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/40 rounded text-sm hover:bg-accent-cyan/30 disabled:opacity-40"
                  >
                    Resume
                  </button>
                )}
                {goal && !GOAL_TERMINAL.includes(goal.state) && (
                  <button
                    onClick={saveGoalForm}
                    className="px-3 py-1.5 border border-border rounded text-sm hover:bg-bg-tertiary"
                  >
                    Save
                  </button>
                )}
                {goal && (
                  <button
                    onClick={clearGoal}
                    className="px-3 py-1.5 border border-accent-red/40 text-accent-red rounded text-sm hover:bg-accent-red/10"
                  >
                    Remove goal
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
