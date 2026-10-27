import { useEffect, useMemo, useState } from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import MainPanel from './components/MainPanel';
import MissionIntel from './components/MissionIntel';
import ShellPanel from './components/ShellPanel';
import NewMissionModal from './components/NewMissionModal';
import TasksModal from './components/TasksModal';
import MultiRunModal, { type RunSpec } from './components/MultiRunModal';
import RunCompareModal from './components/RunCompareModal';
import SessionsDashboard from './components/SessionsDashboard';
import { loadLLMSettings } from './lib/llm';
import { runScheduledAgent, runTurn } from './lib/agent';
import {
  deleteSession,
  isTaskDue,
  loadRunGroups,
  loadSessions,
  loadTasks,
  newSession,
  saveRunGroups,
  saveSessions,
  saveTasks,
  type PermissionMode,
  type RunGroup,
  type ScheduledTask,
  type Session,
  type StoredMsg,
  type Workspace,
} from './lib/store';
import { deleteMission, loadMissions, missionKind, saveMissions, updateMission, type Mission, type MissionKind } from './lib/missions';
import { maybeSeedDemo } from './lib/demoSeed';
import { Toaster } from './lib/toast';
import PlaybookModal from './components/PlaybookModal';

maybeSeedDemo();

interface Usage {
  prompt: number;
  completion: number;
  total: number;
  calls: number;
}

const WORKSPACE_KEY = 'vulnexis.workspace';

function loadWorkspace(): Workspace {
  const w = localStorage.getItem(WORKSPACE_KEY);
  return w === 'assistant' || w === 'pentest' || w === 'bugbounty' ? w : 'assistant';
}

const kindOf = (w: Workspace): MissionKind | null =>
  w === 'bugbounty' ? 'bugbounty' : w === 'pentest' ? 'pentest' : null;

function App() {
  const [shellCollapsed, setShellCollapsed] = useState(false);
  const [intelCollapsed, setIntelCollapsed] = useState(false);
  const [missionModalOpen, setMissionModalOpen] = useState(false);
  const [tasksModalOpen, setTasksModalOpen] = useState(false);
  const [multiRunOpen, setMultiRunOpen] = useState(false);
  const [playbookOpen, setPlaybookOpen] = useState(false);
  const [compareGroupId, setCompareGroupId] = useState<string | null>(null);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
  const [budgetTokens, setBudgetTokens] = useState<number>(0);
  const [taskTick, setTaskTick] = useState(0);
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set());
  const [runGroups, setRunGroups] = useState<RunGroup[]>(() => loadRunGroups());

  const [missions, setMissions] = useState<Mission[]>(() => loadMissions());
  const [workspace, setWorkspace] = useState<Workspace>(loadWorkspace);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingMission, setEditingMission] = useState<Mission | null>(null);
  const [usage, setUsage] = useState<Usage>({ prompt: 0, completion: 0, total: 0, calls: 0 });

  const [sessions, setSessions] = useState<Session[]>(() => loadSessions());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  useEffect(() => {
    saveSessions(sessions);
  }, [sessions]);
  useEffect(() => {
    saveMissions(missions);
  }, [missions]);

  const activeMission = missions.find((m) => m.id === activeId) ?? null;
  // Assistant workspace = Kali-free plain chats (missionId null). Pentest and
  // Bug Bounty workspaces each list only their own missions.
  const workspaceMissions = useMemo(
    () => (kindOf(workspace) ? missions.filter((m) => missionKind(m) === kindOf(workspace)) : []),
    [missions, workspace]
  );
  const visibleSessions =
    workspace === 'assistant'
      ? sessions.filter((s) => s.missionId === null)
      : activeId
        ? sessions.filter((s) => s.missionId === activeId)
        : [];
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const visibleRunGroups = activeId ? runGroups.filter((g) => g.missionId === activeId) : [];

  // Select the first mission of the workspace on mount / workspace switch
  useEffect(() => {
    if (workspace === 'assistant') {
      setActiveId(null);
    } else {
      const kind = kindOf(workspace);
      const first = missions.find((m) => missionKind(m) === kind);
      setActiveId(first?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  const changeWorkspace = (w: Workspace) => {
    if (w === workspace) return;
    setWorkspace(w);
    localStorage.setItem(WORKSPACE_KEY, w);
    // Set everything in one batch so the ensure-effect can't resurrect the
    // previous workspace's session mid-transition.
    const kind = kindOf(w);
    const first = kind ? missions.find((m) => missionKind(m) === kind) : null;
    setActiveId(first?.id ?? null);
    setActiveSessionId(null);
  };
  const compareGroup = compareGroupId ? runGroups.find((g) => g.id === compareGroupId) ?? null : null;
  const compareRuns = compareGroup
    ? compareGroup.runIds
        .map((id) => sessions.find((s) => s.id === id))
        .filter((s): s is Session => !!s)
    : [];
  const settings = loadLLMSettings();
  const costPerM = settings.pricePerMTok;

  // Ensure the active context has a session. In mission workspaces the selected
  // mission always gets one; only the assistant workspace keeps plain chats.
  useEffect(() => {
    if (activeId) {
      const existing = sessions.filter((s) => s.missionId === activeId);
      if (existing.length === 0) {
        const s = newSession(activeId, 'pentest', 'Session 1');
        setSessions((prev) => (prev.some((x) => x.missionId === activeId) ? prev : [...prev, s]));
        setActiveSessionId(s.id);
      } else if (!existing.find((s) => s.id === activeSessionId)) {
        setActiveSessionId(existing[0].id);
      }
    } else if (workspace === 'assistant') {
      const chats = sessions.filter((s) => s.missionId === null);
      if (chats.length === 0) {
        const s = newSession(null, 'pentest', 'Chat');
        setSessions((prev) => (prev.some((x) => x.missionId === null) ? prev : [...prev, s]));
        setActiveSessionId(s.id);
      } else if (!chats.find((s) => s.id === activeSessionId)) {
        setActiveSessionId(chats[0].id);
      }
    }
  }, [activeId, workspace, sessions, activeSessionId]);

  // Scheduler: check tasks every 30s
  useEffect(() => {
    const runDue = async () => {
      if (!activeMission || !connected) return;
      const tasks = loadTasks();
      const due = tasks.filter((t) => t.missionId === activeMission.id && isTaskDue(t));
      for (const t of due) {
        await runTaskInternal(t, activeMission);
      }
    };
    const iv = setInterval(runDue, 30000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMission, connected]);

  const createMission = (mission: Mission) => {
    setMissions((ms) => {
      const exists = ms.find((m) => m.id === mission.id);
      if (exists) {
        const updated = updateMission(mission);
        return updated ?? ms.map((m) => (m.id === mission.id ? mission : m));
      }
      const next = [mission, ...ms];
      saveMissions(next);
      return next;
    });
    setActiveId(mission.id);
    // Ensure we land in the workspace matching the mission kind
    const w: Workspace = missionKind(mission) === 'bugbounty' ? 'bugbounty' : 'pentest';
    if (w !== workspace) {
      setWorkspace(w);
      localStorage.setItem(WORKSPACE_KEY, w);
    }
  };

  const removeMission = (id: string) => {
    if (!id) return;
    const all = deleteMission(id);
    setMissions(all);
    if (activeId === id) {
      const kind = workspace === 'bugbounty' ? 'bugbounty' : workspace === 'pentest' ? 'pentest' : null;
      if (kind) {
        const first = all.find((m) => missionKind(m) === kind);
        setActiveId(first?.id ?? null);
      } else {
        setActiveId(null);
      }
    }
    // Also clean up sessions for this mission
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.missionId !== id);
      saveSessions(remaining);
      return remaining;
    });
    if (activeSessionId && sessions.find((s) => s.id === activeSessionId)?.missionId === id) {
      setActiveSessionId(null);
    }
  };

  /** Global usage accumulation plus per-session token tracking. */
  const handleUsageFor = (sessionId: string | null) => (u: Usage) => {
    setUsage((prev) => ({
      prompt: prev.prompt + u.prompt,
      completion: prev.completion + u.completion,
      total: prev.total + u.total,
      calls: prev.calls + u.calls,
    }));
    if (sessionId) {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                usage: {
                  total: (s.usage?.total ?? 0) + u.total,
                  calls: (s.usage?.calls ?? 0) + u.calls,
                },
              }
            : s
        )
      );
    }
  };

  const updateSession = (next: Session) => {
    setSessions((prev) => prev.map((s) => (s.id === next.id ? next : s)));
  };

  const newSessionForMission = () => {
    if (!activeId && workspace !== 'assistant') return; // no mission selected
    const count = sessions.filter((s) => s.missionId === activeId).length + 1;
    const s = newSession(activeId, activeSession?.agent ?? 'pentest', activeId ? `Session ${count}` : `Chat ${count}`);
    setSessions((prev) => [s, ...prev]);
    setActiveSessionId(s.id);
  };

  const removeSession = (id: string) => {
    const remaining = deleteSession(id, sessions);
    setSessions(remaining);
    if (activeSessionId === id) {
      const next = activeId ? remaining.find((s) => s.missionId === activeId) : remaining.find((s) => s.missionId === null);
      setActiveSessionId(next?.id ?? null);
    }
  };

  const forkFrom = (forked: Session) => {
    setSessions((prev) => [forked, ...prev]);
    setActiveSessionId(forked.id);
  };

  const runTaskInternal = async (task: ScheduledTask, mission: Mission): Promise<string | null> => {
    if (!connected) return 'Kali not connected — connect via Settings first.';
    const session = newSession(task.missionId, 'recon', `Task: ${task.name}`);
    session.messages.push({ role: 'user', text: task.prompt, ts: new Date().toISOString() });
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    const updated = await runScheduledAgent(mission, session);
    setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    const tasks = loadTasks().map((t) => (t.id === task.id ? { ...t, lastRun: new Date().toISOString(), sessionId: session.id } : t));
    saveTasks(tasks);
    return null;
  };

  // Multi-run: launch up to 5 parallel sessions from one prompt, each with
  // its own agent focus and optional model override, grouped under one id.
  const launchMultiRun = (name: string, prompt: string, runs: RunSpec[]) => {
    if (!activeId || !activeMission || !prompt) return;
    const groupId = 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const created: Session[] = runs.map((r, i) => {
      const s = newSession(activeId, r.agent, `${name} · ${r.agent}${runs.length > 1 ? ` ${i + 1}` : ''}`);
      if (r.model) {
        s.model = r.model;
        s.provider = r.provider;
        s.baseUrl = r.baseUrl;
      }
      s.groupId = groupId;
      return s;
    });
    const group: RunGroup = {
      id: groupId,
      missionId: activeId,
      name,
      prompt,
      runIds: created.map((s) => s.id),
      createdAt: new Date().toISOString(),
    };
    const groups = [...loadRunGroups(), group];
    saveRunGroups(groups);
    setRunGroups(groups);
    setSessions((prev) => [...created, ...prev]);
    setCompareGroupId(groupId);
    setMultiRunOpen(false);

    for (const s of created) {
      setRunningIds((prev) => new Set(prev).add(s.id));
      runTurn(activeMission, s, prompt, {
        connected,
        permission: permissionMode,
        budget: budgetTokens,
        usageTotal: usage.total,
        onUpdate: updateSession,
        onUsage: handleUsageFor(s.id),
      })
        .catch(() => {})
        .finally(() => {
          setRunningIds((prev) => {
            const next = new Set(prev);
            next.delete(s.id);
            return next;
          });
        });
    }
  };

  const appendToActiveSession = (text: string) => {
    if (!activeSession) return;
    const msg: StoredMsg = { role: 'assistant', text, ts: new Date().toISOString() };
    updateSession({
      ...activeSession,
      messages: [...activeSession.messages, msg],
      updatedAt: new Date().toISOString(),
    });
  };

  /** One agent turn in the active session — used by the playbook runner. */
  const runPlaybookPhase = async (text: string) => {
    if (!activeMission || !activeSession) throw new Error('No active mission or session.');
    if (!connected) throw new Error('Kali is not connected — connect via Settings first.');
    const after = await runTurn(activeMission, activeSession, text, {
      connected,
      permission: permissionMode,
      budget: budgetTokens,
      usageTotal: usage.total,
      onUpdate: updateSession,
      onUsage: handleUsageFor(activeSession.id),
    });
    updateSession(after);
  };

  const promoteRun = (run: Session) => {
    const last = [...run.messages].reverse().find((m) => m.role === 'assistant');
    if (!last) return;
    appendToActiveSession(
      `[promoted from multi-run "${run.name}" — ${run.model ?? 'default model'}]\n${last.text}`
    );
  };

  const openRunInDashboard = (id: string, missionId: string | null) => {
    if (missionId !== activeId) setActiveId(missionId);
    setActiveSessionId(id);
    setDashboardOpen(false);
  };

  const cost = (usage.total / 1_000_000) * settings.pricePerMTok;
  const tasks = loadTasks();
  const activeTaskCount = activeId ? tasks.filter((t) => t.missionId === activeId && t.enabled).length : 0;

  return (
    <div className="h-screen w-screen bg-bg-primary text-text-primary flex overflow-hidden">
      <Sidebar
        workspace={workspace}
        onWorkspaceChange={changeWorkspace}
        missions={workspaceMissions}
        activeId={activeId}
        sessions={visibleSessions}
        activeSessionId={activeSessionId}
        taskCount={activeTaskCount}
        runGroups={visibleRunGroups}
        onNewMission={() => {
          setEditingMission(null);
          setMissionModalOpen(true);
        }}
        onSelect={setActiveId}
        onNewSession={newSessionForMission}
        onSelectSession={setActiveSessionId}
        onDeleteSession={removeSession}
        onEditMission={(m: Mission) => {
          setEditingMission(m);
          setMissionModalOpen(true);
        }}
        onDeleteMission={removeMission}
        onOpenTasks={() => setTasksModalOpen(true)}
        onOpenRunGroup={setCompareGroupId}
        onOpenDashboard={() => setDashboardOpen(true)}
      />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <TopBar
          mission={activeMission}
          workspace={workspace}
          connected={connected}
          onConnectionChange={setConnected}
          usage={{ total: usage.total, calls: usage.calls, cost }}
        />
        <div className="flex-1 flex overflow-hidden">
          <MainPanel
          mission={activeMission}
          session={activeSession}
          connected={connected}
          permissionMode={permissionMode}
          budgetTokens={budgetTokens}
          usageTotal={usage.total}
          onPermissionChange={(m) => {
            if (m === 'full') {
              const ok = window.confirm(
                'FULL AUTOPILOT will run every suggested command automatically without approval.\nOnly use this for lab machines you own.\n\nEnable?'
              );
              if (!ok) return;
            }
            setPermissionMode(m);
          }}
          onBudgetChange={setBudgetTokens}
          onUsage={handleUsageFor(activeSessionId)}
          onUpdateSession={updateSession}
          onFork={forkFrom}
          onNewMission={() => setMissionModalOpen(true)}
          onOpenMultiRun={() => setMultiRunOpen(true)}
          onOpenPlaybook={() => setPlaybookOpen(true)}
        />
        {!intelCollapsed ? (
          <MissionIntel
            mission={activeMission}
            session={activeSession}
            connected={connected}
            onCollapse={() => setIntelCollapsed(true)}
          />
        ) : (
          <button
            onClick={() => setIntelCollapsed(false)}
            className="w-6 border-l border-border bg-bg-secondary hover:bg-bg-tertiary text-text-secondary hover:text-text-primary flex items-center justify-center"
            title="Show Mission Intel"
          >
            ‹
          </button>
        )}
      </div>
      {!shellCollapsed ? (
        <ShellPanel onCollapse={() => setShellCollapsed(true)} />
      ) : (
        <button
          onClick={() => setShellCollapsed(false)}
          className="h-6 border-t border-border bg-bg-secondary hover:bg-bg-tertiary text-text-secondary hover:text-text-primary flex items-center justify-center text-xs"
          title="Show Shell"
        >
          ▲
        </button>
      )}
      </div>
      {missionModalOpen && (
        <NewMissionModal
          kind={editingMission?.kind ?? (workspace === 'bugbounty' ? 'bugbounty' : 'pentest')}
          mission={editingMission}
          onClose={() => {
            setMissionModalOpen(false);
            setEditingMission(null);
          }}
          onCreate={createMission}
        />
      )}
      {tasksModalOpen && activeMission && (
        <TasksModal
          key={taskTick}
          mission={activeMission}
          onClose={() => setTasksModalOpen(false)}
          onRunTask={(t) => runTaskInternal(t, activeMission)}
          onOpenSession={(id) => {
            setActiveSessionId(id);
            setTasksModalOpen(false);
          }}
          onTasksChanged={() => setTaskTick((x) => x + 1)}
        />
      )}
      {multiRunOpen && activeMission && (
        <MultiRunModal
          missionName={activeMission.name}
          onClose={() => setMultiRunOpen(false)}
          onLaunch={launchMultiRun}
        />
      )}
      {playbookOpen && activeMission && activeSession && (
        <PlaybookModal
          mission={activeMission}
          runPrompt={runPlaybookPhase}
          onClose={() => setPlaybookOpen(false)}
        />
      )}
      {compareGroup && (
        <RunCompareModal
          group={compareGroup}
          mission={missions.find((m) => m.id === compareGroup.missionId) ?? null}
          runs={compareRuns}
          runningIds={runningIds}
          costPerM={costPerM}
          onClose={() => setCompareGroupId(null)}
          onOpenRun={(id) => {
            const run = sessions.find((s) => s.id === id);
            if (!run) return;
            if (run.missionId !== activeId) setActiveId(run.missionId);
            setActiveSessionId(id);
            setCompareGroupId(null);
          }}
          onPromote={promoteRun}
          onFusion={appendToActiveSession}
        />
      )}
      {dashboardOpen && (
        <SessionsDashboard
          sessions={sessions}
          missions={missions}
          runningIds={runningIds}
          costPerM={costPerM}
          onClose={() => setDashboardOpen(false)}
          onOpenSession={openRunInDashboard}
        />
      )}
      <Toaster />
    </div>
  );
}

export default App;
