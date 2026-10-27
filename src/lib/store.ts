// VulNexis state management: sessions, scheduled tasks — persisted in localStorage
// (missions live in missions.ts; legacy `vulnexis.missions` key migrated there)

export interface StoredMsg {
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  ts: string;
  /** Live tool-activity metadata (ShipChamber-style blocks). */
  meta?: {
    label: string;
    cmd?: string;
    state: 'running' | 'done' | 'error';
    /** 'tasks' renders the checklist UI instead of a generic tool block. */
    kind?: 'tool' | 'tasks';
    tasks?: SessionTask[];
  };
}

export type TaskState = 'pending' | 'in_progress' | 'done';

/** One checklist item of the agent's working plan (ShipChamber todo list). */
export interface SessionTask {
  title: string;
  state: TaskState;
}

export type SessionAgent = 'pentest' | 'recon' | 'web' | 'privesc' | 'expl' | 'replan';

export const AGENTS: Record<SessionAgent, { name: string; description: string }> = {
  pentest: {
    name: 'Pentest',
    description: 'Balanced methodology: recon, enumeration, then targeted testing.',
  },
  recon: {
    name: 'Recon',
    description: 'Attack-surface mapping: subdomains, ports, technologies, endpoints.',
  },
  web: {
    name: 'Web',
    description: 'HTTP surface: endpoints, parameters, auth flows, business logic.',
  },
  privesc: {
    name: 'PrivEsc',
    description: 'Privilege escalation paths once initial access is achieved.',
  },
  expl: {
    name: 'Exploit',
    description: 'Safe validation of identified vulnerabilities.',
  },
  replan: {
    name: 'Replan',
    description: 'Re-evaluate findings so far and propose next steps.',
  },
};

export interface Session {
  id: string;
  missionId: string | null; // null = general chat (no mission), like a plain AI chat
  name: string;
  agent: SessionAgent;
  createdAt: string;
  updatedAt: string;
  messages: StoredMsg[];
  forkFrom?: string; // id of the session this was forked from
  goal?: SessionGoal;
  tasks?: SessionTask[]; // agent's working checklist (latest state)
  groupId?: string; // multi-run group this session belongs to
  model?: string; // per-session model override
  provider?: string; // per-session provider override (with baseUrl)
  baseUrl?: string;
  usage?: { total: number; calls: number }; // tokens tracked for this session
}

export type GoalState = 'pending' | 'running' | 'complete' | 'blocked' | 'budget';

export interface SessionGoal {
  title: string;
  criteria: string; // self-contained objective the auditor judges against
  state: GoalState;
  note: string; // latest auditor progress note
  turns: number; // auto-continuations used
  maxTurns: number;
  budget: number; // token budget for the goal, 0 = none
  blockedStreak: number;
  createdAt: string;
}

export interface RunGroup {
  id: string;
  missionId: string;
  name: string;
  prompt: string;
  runIds: string[];
  createdAt: string;
}

export type PermissionMode = 'ask' | 'auto-low' | 'full';

export type Workspace = 'assistant' | 'pentest' | 'bugbounty';

export type TaskType = 'daily' | 'weekly' | 'once';

export interface ScheduledTask {
  id: string;
  missionId: string;
  name: string;
  prompt: string;
  type: TaskType;
  time: string; // HH:MM
  days?: number[]; // weekly: 0 (Sun) - 6 (Sat)
  date?: string; // once: YYYY-MM-DD
  enabled: boolean;
  lastRun?: string;
  sessionId?: string; // session created by the last run
}

const SESSIONS_KEY = 'vulnexis.sessions';
const TASKS_KEY = 'vulnexis.tasks';

export function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    return raw ? (JSON.parse(raw) as Session[]) : [];
  } catch {
    return [];
  }
}

export function saveSessions(sessions: Session[]) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

export function loadTasks(): ScheduledTask[] {
  try {
    const raw = localStorage.getItem(TASKS_KEY);
    return raw ? (JSON.parse(raw) as ScheduledTask[]) : [];
  } catch {
    return [];
  }
}

export function saveTasks(tasks: ScheduledTask[]) {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
}

const RUNGROUPS_KEY = 'vulnexis.rungroups';

export function loadRunGroups(): RunGroup[] {
  try {
    const raw = localStorage.getItem(RUNGROUPS_KEY);
    return raw ? (JSON.parse(raw) as RunGroup[]) : [];
  } catch {
    return [];
  }
}

export function saveRunGroups(groups: RunGroup[]) {
  localStorage.setItem(RUNGROUPS_KEY, JSON.stringify(groups));
}

export function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function newSession(missionId: string | null, agent: SessionAgent, name: string): Session {
  const now = new Date().toISOString();
  return {
    id: 's_' + newId(),
    missionId,
    name,
    agent,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export function deleteSession(id: string, sessions: Session[]): Session[] {
  return sessions.filter((s) => s.id !== id);
}

/** Fork a session, optionally truncating the history at a message index. */
export function forkSession(session: Session, uptoMessageIndex?: number): Session {
  const now = new Date().toISOString();
  const messages =
    uptoMessageIndex === undefined ? session.messages : session.messages.slice(0, uptoMessageIndex);
  return {
    ...session,
    id: 's_' + newId(),
    name: `${session.name} (fork)`,
    createdAt: now,
    updatedAt: now,
    messages,
    forkFrom: session.id,
  };
}

/** True when a task's time slot has arrived and has not run for that slot yet. */
export function isTaskDue(task: ScheduledTask): boolean {
  if (!task.enabled) return false;
  const now = new Date();
  const [hh, mm] = (task.time || '09:00').split(':').map(Number);
  const slot = new Date(now);
  slot.setHours(hh || 0, mm || 0, 0, 0);

  switch (task.type) {
    case 'daily':
      if (now < slot) return false;
      return !task.lastRun || new Date(task.lastRun) < slot;
    case 'weekly':
      if (now < slot) return false;
      if (!(task.days ?? []).includes(now.getDay())) return false;
      return !task.lastRun || new Date(task.lastRun) < slot;
    case 'once': {
      if (!task.date) return false;
      const target = new Date(`${task.date}T${task.time || '09:00'}`);
      if (now < target) return false;
      return !task.lastRun || new Date(task.lastRun) < target;
    }
    default:
      return false;
  }
}
