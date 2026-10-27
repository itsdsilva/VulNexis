import { useEffect, useRef, useState } from 'react';
import Markdown from './Markdown';
import type { Mission } from '../lib/missions';
import { forkSession, type GoalState, type PermissionMode, type Session, type SessionGoal, type StoredMsg } from '../lib/store';
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
  pentest: 'text-accent-cyan',
  recon: 'text-accent-green',
  web: 'text-accent-purple',
  privesc: 'text-accent-amber',
  expl: 'text-accent-red',
  replan: 'text-accent-purple',
};

const GOAL_TERMINAL: GoalState[] = ['complete', 'blocked', 'budget'];

const goalStateStyle: Record<GoalState, { dot: string; chip: string; label: string }> = {
  pending: { dot: 'text-accent-amber', chip: 'border-accent-amber/40 text-accent-amber', label: 'ready' },
  running: { dot: 'text-accent-cyan animate-pulse', chip: 'border-accent-cyan/40 text-accent-cyan', label: 'running' },
  complete: { dot: 'text-accent-green', chip: 'border-accent-green/40 text-accent-green', label: 'complete' },
  blocked: { dot: 'text-accent-red', chip: 'border-accent-red/40 text-accent-red', label: 'blocked' },
  budget: { dot: 'text-accent-red', chip: 'border-accent-red/40 text-accent-red', label: 'budget reached' },
};

/** ShipChamber-style collapsible tool block — collapsed by default. */
function ToolBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const firstLine = (text || '').split('\n').find((l) => l.trim()) ?? 'output';
  return (
    <div className="rounded-lg border border-bordermuted bg-bg-secondary overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-tertiary/50 transition-colors"
      >
        <span className={`inline-block transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>▸</span>
        <span className="font-medium">tool output</span>
        <span className="truncate flex-1 text-left font-mono opacity-60">{firstLine}</span>
      </button>
      {open && (
        <pre className="px-3 py-2 text-[11px] font-mono text-text-secondary leading-relaxed border-t border-bordermuted overflow-x-auto whitespace-pre-wrap break-words">
          {text}
        </pre>
      )}
    </div>
  );
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

function Message({ m }: { m: StoredMsg }) {
  if (m.role === 'tool') return <ToolBlock text={m.text} />;
  if (m.role === 'error') {
    return (
      <div className="border-l-2 border-accent-red/60 pl-3 text-xs text-accent-red whitespace-pre-wrap break-words">
        <div className="micro-label !text-accent-red/70 mb-1">error</div>
        {m.text}
      </div>
    );
  }
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] w-fit bg-accent-orange/15 border border-accent-orange/25 rounded-xl px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words text-text-primary">
          {m.text}
        </div>
      </div>
    );
  }
  // assistant — Notion doc feel: plain text, no box
  return (
    <div className="text-sm">
      <Markdown text={m.text} />
    </div>
  );
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
  const [listening, setListening] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const recRef = useRef<any>(null);
  const wantListeningRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Anchor for cursor insertion: text before/after the caret when dictation started
  const anchorRef = useRef<{ before: string; after: string }>({ before: '', after: '' });
  const sessionFinalRef = useRef('');
  const caretRef = useRef<number | null>(null);
  const pendingCaretRef = useRef(false);
  const errCountRef = useRef(0);
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

  // Restore the caret to the dictation insertion point after each
  // recognition-driven input update (so typing and dictation interleave).
  useEffect(() => {
    if (pendingCaretRef.current && textareaRef.current && caretRef.current !== null) {
      const pos = Math.min(caretRef.current, textareaRef.current.value.length);
      textareaRef.current.selectionStart = pos;
      textareaRef.current.selectionEnd = pos;
      pendingCaretRef.current = false;
    }
  }, [input]);

  /**
   * Voice input — Web Speech API with pause resilience:
   * - `continuous` + auto-restart in onend keeps the session alive through
   *   long silences (many engines auto-stop after a few seconds of quiet).
   * - Final chunks accumulate across restarts; interim text is re-rendered
   *   live.
   * - Transcript is inserted at the caret captured at dictation start, not
   *   appended to the end, and the caret is restored after every update.
   */
  const toggleMic = () => {
    if (listening) {
      // Stop: keep applying any final chunk that flushes, then clean up in onend
      wantListeningRef.current = false;
      recRef.current?.stop();
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      window.alert('Voice input is not supported in this environment.');
      return;
    }
    const ta = textareaRef.current;
    const value = ta ? ta.value : input;
    const selStart = ta ? (ta.selectionStart ?? value.length) : value.length;
    const selEnd = ta ? (ta.selectionEnd ?? selStart) : value.length;
    anchorRef.current = { before: value.slice(0, selStart), after: value.slice(selEnd) };
    sessionFinalRef.current = '';
    errCountRef.current = 0;
    wantListeningRef.current = true;
    try {
      const rec = new SR();
      recRef.current = rec;
      rec.lang = navigator.language || 'en-US';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e: any) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const t = r[0].transcript;
          if (r.isFinal) {
            const prev = sessionFinalRef.current;
            sessionFinalRef.current = prev && !prev.endsWith(' ') ? prev + ' ' + t.trim() : prev + t.trim();
          } else {
            interim += t;
          }
        }
        const chunk =
          sessionFinalRef.current + (interim ? (sessionFinalRef.current ? ' ' : '') + interim : '');
        const { before, after } = anchorRef.current;
        caretRef.current = before.length + chunk.length;
        pendingCaretRef.current = true;
        setInput(before + chunk + after);
      };
      rec.onend = () => {
        // Long pause: engine ended on its own — restart while the user still wants dictation
        if (wantListeningRef.current) {
          window.setTimeout(() => {
            if (!wantListeningRef.current) return;
            try {
              rec.start();
            } catch {
              // already starting; onend will retry
            }
          }, 250);
        } else {
          setListening(false);
          recRef.current = null;
        }
      };
      rec.onerror = (e: any) => {
        const err = e?.error;
        if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') {
          // Hard failure — stop trying, tell the user
          wantListeningRef.current = false;
          setListening(false);
          recRef.current = null;
          window.alert('Microphone unavailable or permission denied.');
          return;
        }
        // no-speech / aborted / network blips: onend decides whether to restart.
        // Guard against endless restart loops on persistent failures.
        errCountRef.current++;
        if (errCountRef.current > 8) {
          wantListeningRef.current = false;
          setListening(false);
          recRef.current = null;
        }
      };
      rec.start();
      setListening(true);
    } catch {
      wantListeningRef.current = false;
      setListening(false);
      recRef.current = null;
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-bg-primary">
      {/* Session header — blends with the canvas; hairline appears only when scrolled */}
      <div
        className={`h-11 flex items-center px-3.5 gap-2 shrink-0 bg-bg-primary ${
          scrolled ? 'border-b border-bordermuted' : 'border-b border-transparent'
        }`}
      >
        <span className="text-[13px] font-medium truncate">{session?.name ?? 'New chat'}</span>
        {session && session.agent !== 'recon' && (
          <span className={`text-[11px] font-medium ${agentBadge[session.agent] ?? 'text-text-muted'}`}>
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
            className="text-xs text-text-secondary hover:text-text-primary px-2 py-1 rounded-md hover:bg-bg-tertiary"
            title="Fork this session — copy history into a new session"
          >
            fork
          </button>
        )}
        {mission && (
          <button
            onClick={onOpenMultiRun}
            className="text-xs text-text-secondary hover:text-text-primary px-2 py-1 rounded-md hover:bg-bg-tertiary"
            title="Run the same prompt across several parallel sessions"
          >
            multi-run
          </button>
        )}
        {mission && (
          <button
            onClick={onOpenPlaybook}
            className="text-xs text-text-secondary hover:text-text-primary px-2 py-1 rounded-md hover:bg-bg-tertiary"
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
              className="bg-bg-tertiary border border-bordermuted rounded-md px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary cursor-pointer"
            >
              <option value="ask">ask every command</option>
              <option value="auto-low">auto-run low risk</option>
              <option value="full">full autopilot</option>
            </select>
            <button
              onClick={() => setShowSettings((v) => !v)}
              className={`text-[11px] px-2 py-1 rounded-md ${showSettings ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'}`}
              title="Token budget settings"
            >
              budget
            </button>
          </div>
        )}
      </div>

      {mission && showSettings && (
        <div className="border-b border-bordermuted bg-bg-secondary/60 px-4 py-2.5 flex items-center gap-3 text-xs shrink-0">
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
        <div className="border-b border-bordermuted bg-bg-secondary/60 px-4 py-2 flex items-center gap-2 text-xs shrink-0">
          <span className={goalStateStyle[goal.state].dot}>◎</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${goalStateStyle[goal.state].chip}`}>
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
              className="text-text-secondary hover:text-text-primary px-1.5 py-0.5 rounded-md hover:bg-bg-tertiary"
              title="Pause the goal loop and stop after the current turn"
            >
              pause
            </button>
          )}
          {goal.state === 'pending' && (
            <button
              onClick={resumeGoal}
              disabled={busy}
              className="text-accent-cyan hover:text-accent-cyan/80 px-1.5 py-0.5 rounded-md hover:bg-bg-tertiary disabled:opacity-40"
              title="Resume — re-run the goal loop now"
            >
              resume
            </button>
          )}
          <button onClick={openGoalDialog} className="text-text-secondary hover:text-text-primary px-1.5 py-0.5 rounded-md hover:bg-bg-tertiary" title="Edit, remove or review the goal">
            edit
          </button>
        </div>
      )}

      {/* Messages — unboxed conversation, Notion doc typography */}
      <div
        ref={scrollRef}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}
        className="flex-1 overflow-y-auto px-4 py-5"
      >
        <div className="max-w-3xl mx-auto space-y-3">
          {session?.messages.length === 0 && (
            <div className="text-text-muted text-sm px-2 pt-8 text-center">
              {mission
                ? `Mission "${mission.name}" is active. Describe what you want to test, paste scan output, or ask for a plan.`
                : 'Ask anything — this is a plain AI chat. Create a mission to let the agent run tools on your Kali VM.'}
            </div>
          )}
          {session?.messages.map((m, i) => (
            <Message key={i} m={m} />
          ))}
          {busy && phase === 'turn' && <div className="text-text-muted text-sm italic px-2 animate-pulse">thinking…</div>}
          {busy && phase === 'eval' && (
            <div className="text-accent-cyan text-sm italic px-2 animate-pulse">goal loop running — auditing progress…</div>
          )}
        </div>
      </div>

      {/* Composer — ShipChamber style: bordered card, circular send */}
      <div className="px-4 pb-3 pt-1 shrink-0 relative bg-bg-primary">
        <div className="max-w-3xl mx-auto">
          {mission && (
            <div className="flex items-center gap-1 pb-1.5 text-xs flex-wrap">
              <span className="micro-label mr-1">workflows</span>
              {WORKFLOWS.map((w) => (
                <button
                  key={w.id}
                  onClick={() => runWorkflowById(w.id)}
                  disabled={!connected || busy}
                  title={w.description}
                  className="px-2 py-1 rounded-md text-[11px] text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  {w.name}
                </button>
              ))}
            </div>
          )}
          {goalArmed && (
            <div className="flex items-center gap-2 pb-1.5 text-xs">
              <span className="text-accent-amber">◎ goal armed</span>
              <span className="text-text-muted">your next message becomes the goal objective</span>
              <button onClick={() => setGoalArmed(false)} className="text-text-secondary hover:text-text-primary">
                cancel
              </button>
            </div>
          )}
          <div className="rounded-xl border border-border bg-bg-secondary px-3 py-2 focus-within:border-accent-orange/60 focus-within:shadow-glow transition-all">
            <textarea
              ref={textareaRef}
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
              className="flex-1 w-full bg-transparent border-0 px-0 py-0.5 text-sm resize-none focus:outline-none focus:ring-0 disabled:opacity-50 placeholder:text-text-disabled"
            />
            <div className="flex items-end justify-between mt-0.5">
              <span className="text-[10px] text-text-disabled pl-0.5">
                {listening ? 'listening…' : 'Enter to send · Shift+Enter for a new line'}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={toggleMic}
                  disabled={busy}
                  className={`w-7 h-7 rounded-full flex items-center justify-center border transition-colors disabled:opacity-30 ${
                    listening
                      ? 'bg-accent-orange/15 text-accent-orange border-accent-orange/60 animate-pulse'
                      : 'border-bordermuted text-text-secondary hover:text-text-primary hover:border-border'
                  }`}
                  title={listening ? 'Stop voice input' : 'Voice input'}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="2" width="6" height="12" rx="3" />
                    <path d="M5 10a7 7 0 0 0 14 0" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                  </svg>
                </button>
                <button
                  onClick={send}
                  disabled={busy || !input.trim()}
                  className="w-7 h-7 rounded-full btn-primary flex items-center justify-center text-sm leading-none disabled:!opacity-30"
                  title="Send"
                >
                  ↑
                </button>
              </div>
            </div>
          </div>
          {/* Model picker + goal — ghost row under the composer */}
          <div className="flex items-center gap-1 pt-1.5 text-xs">
            <button
              onClick={toggleModelOpen}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
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
              className={`flex items-center gap-1 px-2 py-1 rounded-md ${
                goalActive
                  ? 'text-accent-cyan'
                  : goal?.state === 'complete'
                    ? 'text-accent-green'
                    : goal?.state === 'blocked' || goal?.state === 'budget'
                      ? 'text-accent-red'
                      : goalArmed
                        ? 'text-accent-amber'
                        : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
              }`}
              title={goal ? 'Goal settings' : 'Set a goal — the agent keeps working toward it automatically'}
            >
              <span>◎</span>
              <span>{goal ? 'goal' : 'set goal'}</span>
            </button>
            {!mission && (
              <button
                onClick={onNewMission}
                className="px-2 py-1 rounded-md text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
              >
                + new mission
              </button>
            )}
          </div>
        </div>

        {modelOpen && (
          <div className="absolute bottom-full left-4 right-4 mb-2 bg-bg-elevated border border-border rounded-lg shadow-pop z-40 max-h-80 overflow-y-auto">
            <div className="p-3 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="micro-label w-16">favorites</span>
                {prefs.favorites.length === 0 && <span className="text-[11px] text-text-disabled">none yet — star a model below</span>}
                {prefs.favorites.map((m) => (
                  <span key={m} className="flex items-center gap-1 px-2 py-0.5 rounded border border-accent-amber/30 bg-accent-amber/10 text-[11px] text-accent-amber">
                    <button onClick={() => pickModel(m)} className="font-mono">★ {m}</button>
                    <button onClick={() => setPrefs(toggleFavoriteModel(m))} className="opacity-60 hover:opacity-100">×</button>
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="micro-label w-16">recent</span>
                {prefs.recents.length === 0 && <span className="text-[11px] text-text-disabled">none yet</span>}
                {prefs.recents.map((m) => (
                  <button key={m} onClick={() => pickModel(m)} className="px-2 py-1 rounded-md bg-bg-tertiary text-[11px] font-mono text-text-secondary hover:text-text-primary">
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
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setGoalDialog(false)}>
            <div
              className="bg-bg-elevated border border-border rounded-xl shadow-pop w-[480px] max-h-[85vh] flex flex-col"
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
                    className="w-full bg-bg-tertiary border border-bordermuted rounded-md px-2 py-1.5 text-sm focus:border-accent-cyan/50"
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
                    className="w-full bg-bg-tertiary border border-bordermuted rounded-md px-2 py-1.5 text-sm resize-none focus:border-accent-cyan/50"
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
                      className="w-24 bg-bg-tertiary border border-bordermuted rounded-md px-2 py-1.5 text-sm focus:border-accent-cyan/50"
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
                      className="w-32 bg-bg-tertiary border border-bordermuted rounded-md px-2 py-1.5 text-sm focus:border-accent-cyan/50"
                    />
                  </div>
                </div>
                {goal && (
                  <div className="text-[10px] text-text-muted border border-bordermuted rounded-md px-2 py-1.5">
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
                      className="px-3 py-1.5 btn-primary text-sm disabled:opacity-40"
                    >
                      Start now
                    </button>
                    <button
                      onClick={() => {
                        setGoalArmed(true);
                        setGoalDialog(false);
                      }}
                      className="px-3 py-1.5 border border-accent-amber/40 text-accent-amber rounded-md text-sm hover:bg-accent-amber/10"
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
                    className="px-3 py-1.5 btn-primary text-sm disabled:opacity-40"
                  >
                    Resume
                  </button>
                )}
                {goal && !GOAL_TERMINAL.includes(goal.state) && (
                  <button
                    onClick={saveGoalForm}
                    className="px-3 py-1.5 border border-border rounded-md text-sm hover:bg-bg-tertiary"
                  >
                    Save
                  </button>
                )}
                {goal && (
                  <button
                    onClick={clearGoal}
                    className="px-3 py-1.5 border border-accent-red/40 text-accent-red rounded-md text-sm hover:bg-accent-red/10"
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
