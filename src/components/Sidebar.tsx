import { type Mission, missionKind, type MissionKind } from '../lib/missions';
import type { RunGroup, Session, Workspace } from '../lib/store';

interface SidebarProps {
  workspace: Workspace;
  onWorkspaceChange: (w: Workspace) => void;
  missions: Mission[];
  activeId: string | null;
  sessions: Session[];
  activeSessionId: string | null;
  taskCount: number;
  runGroups: RunGroup[];
  onNewMission: () => void;
  onSelect: (id: string) => void;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onOpenTasks: () => void;
  onOpenRunGroup: (groupId: string) => void;
  onOpenDashboard: () => void;
}

const WORKSPACES: { id: Workspace; icon: string; label: string; hint: string }[] = [
  { id: 'assistant', icon: '💬', label: 'Assistant', hint: 'General AI chat - no Kali needed' },
  { id: 'pentest', icon: '🎯', label: 'Pentest', hint: 'Authorized penetration testing missions' },
  { id: 'bugbounty', icon: '🐞', label: 'Bug Bounty', hint: 'Your dedicated bug bounty space' },
];

const goalDot: Record<string, string> = {
  pending: 'text-accent-amber',
  running: 'text-accent-cyan',
  complete: 'text-accent-green',
  blocked: 'text-accent-red',
  budget: 'text-accent-red',
};

const kindBadge: Record<MissionKind, { label: string; cls: string }> = {
  pentest: { label: 'PT', cls: 'text-accent-cyan' },
  bugbounty: { label: 'BB', cls: 'text-accent-amber' },
};

export default function Sidebar({
  workspace,
  onWorkspaceChange,
  missions,
  activeId,
  sessions,
  activeSessionId,
  taskCount,
  runGroups,
  onNewMission,
  onSelect,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onOpenTasks,
  onOpenRunGroup,
  onOpenDashboard,
}: SidebarProps) {
  const isAssistant = workspace === 'assistant';

  return (
    <aside className="w-64 bg-bg-secondary border-r border-bordermuted flex flex-col">
      {/* Workspace switcher — segmented pill control */}
      <div className="p-2.5 border-b border-bordermuted">
        <div className="flex gap-1 p-1 rounded-full bg-bg-tertiary border border-bordermuted">
          {WORKSPACES.map((w) => (
            <button
              key={w.id}
              onClick={() => onWorkspaceChange(w.id)}
              title={w.hint}
              className={`flex-1 px-1 py-1.5 text-[11px] font-medium rounded-full transition-all ${
                workspace === w.id
                  ? w.id === 'bugbounty'
                    ? 'bg-accent-amber/15 text-accent-amber shadow-card'
                    : w.id === 'pentest'
                      ? 'bg-accent-cyan/15 text-accent-cyan shadow-card'
                      : 'bg-accent-purple/15 text-accent-purple shadow-card'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              <span className="mr-0.5">{w.icon}</span>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-3 border-b border-bordermuted">
        <button
          onClick={isAssistant ? onNewSession : onNewMission}
          className={`w-full px-3 py-2 rounded-lg text-sm font-medium border transition-all hover:shadow-glow ${
            isAssistant
              ? 'bg-accent-purple/10 text-accent-purple border-accent-purple/25 hover:bg-accent-purple/20'
              : 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/25 hover:bg-accent-cyan/20'
          }`}
        >
          {isAssistant ? '+ New Chat' : '+ New Mission'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!isAssistant && (
          <div className="p-3">
            <div className="micro-label mb-2">
              {workspace === 'bugbounty' ? 'Programs' : 'Missions'}
            </div>
            {missions.length === 0 ? (
              <div className="text-xs text-text-disabled italic">
                {workspace === 'bugbounty' ? 'No programs yet' : 'No missions yet'}
              </div>
            ) : (
              <div className="space-y-0.5">
                {missions.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => onSelect(m.id)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors relative ${
                      m.id === activeId
                        ? 'bg-bg-tertiary text-text-primary border border-border'
                        : 'text-text-secondary hover:bg-bg-tertiary/60 hover:text-text-primary border border-transparent'
                    }`}
                  >
                    {m.id === activeId && (
                      <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-accent-cyan"></span>
                    )}
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[9px] font-bold font-mono ${kindBadge[missionKind(m)].cls}`}>
                        {kindBadge[missionKind(m)].label}
                      </span>
                      <span className="font-medium truncate">{m.name}</span>
                    </div>
                    <div className="text-[10px] text-text-muted mt-0.5">
                      {m.scope.domains.length + m.scope.ips.length + m.scope.wildcards.length} targets
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className={`p-3 ${!isAssistant ? 'border-t border-bordermuted' : ''}`}>
          <div className="flex items-center justify-between mb-2">
            <div className="micro-label">{isAssistant ? 'Chats' : 'Sessions'}</div>
            <button onClick={onNewSession} className="text-[11px] text-accent-cyan/80 hover:text-accent-cyan px-1">
              + new
            </button>
          </div>
          <div className="space-y-0.5">
            {sessions.length === 0 ? (
              <div className="text-xs text-text-disabled italic">
                {isAssistant ? 'No chats yet' : 'No sessions yet'}
              </div>
            ) : (
              sessions.map((s) => (
                <div key={s.id} className="group flex items-center">
                  <button
                    onClick={() => onSelectSession(s.id)}
                    className={`flex-1 text-left px-2.5 py-2 rounded-lg text-xs truncate transition-colors relative ${
                      s.id === activeSessionId
                        ? 'bg-bg-tertiary text-text-primary border border-border'
                        : 'text-text-secondary hover:bg-bg-tertiary/60 hover:text-text-primary border border-transparent'
                    }`}
                    title={s.name}
                  >
                    {s.id === activeSessionId && (
                      <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-accent-purple"></span>
                    )}
                    <div className="flex items-center gap-1.5">
                      {s.goal && (
                        <span className={goalDot[s.goal.state] ?? 'text-text-muted'} title={`goal: ${s.goal.state}`}>
                          ◎
                        </span>
                      )}
                      <span className="truncate font-medium">{s.name}</span>
                    </div>
                    <div className="text-[10px] text-text-muted mt-0.5">{s.messages.length} messages</div>
                  </button>
                  <button
                    onClick={() => onDeleteSession(s.id)}
                    className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-accent-red text-xs px-1"
                    title="Delete session"
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {runGroups.length > 0 && (
          <div className="p-3 border-t border-bordermuted">
            <div className="micro-label mb-2">Multi-run groups</div>
            <div className="space-y-0.5">
              {runGroups.map((g) => (
                <button
                  key={g.id}
                  onClick={() => onOpenRunGroup(g.id)}
                  className="w-full text-left px-2.5 py-2 rounded-lg text-xs text-text-secondary hover:bg-bg-tertiary/60 hover:text-text-primary border border-transparent transition-colors"
                  title={g.prompt}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-accent-purple">⚡</span>
                    <span className="truncate font-medium">{g.name}</span>
                  </div>
                  <div className="text-[10px] text-text-muted mt-0.5">{g.runIds.length} runs</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="p-3 border-t border-bordermuted space-y-0.5">
        <button
          onClick={onOpenDashboard}
          className="w-full px-2.5 py-2 text-left text-xs text-text-secondary hover:bg-bg-tertiary/60 hover:text-text-primary rounded-lg transition-colors flex items-center justify-between"
        >
          <span>Sessions Dashboard</span>
          <span className="text-[10px] text-text-muted">all missions</span>
        </button>
        {!isAssistant && (
          <button
            onClick={onOpenTasks}
            className="w-full px-2.5 py-2 text-left text-xs text-text-secondary hover:bg-bg-tertiary/60 hover:text-text-primary rounded-lg transition-colors flex items-center justify-between"
          >
            <span>Scheduled Tasks</span>
            {taskCount > 0 && <span className="text-[10px] text-accent-amber">{taskCount} active</span>}
          </button>
        )}
        <div className="text-[10px] text-text-disabled px-2.5 pt-1 font-mono">v0.2 — authorized testing only</div>
      </div>
    </aside>
  );
}
