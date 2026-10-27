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
  onEditMission?: (m: Mission) => void;
  onDeleteMission?: (id: string) => void;
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
  onEditMission,
  onDeleteMission,
  onOpenTasks,
  onOpenRunGroup,
  onOpenDashboard,
}: SidebarProps) {
  const isAssistant = workspace === 'assistant';

  return (
    <aside className="w-60 bg-bg-secondary border-r border-bordermuted flex flex-col shrink-0">
      {/* Brand — Notion-style sidebar header */}
      <div className="px-3 pt-3 pb-2.5 flex items-center gap-2">
        <img src="/logo_32.png" alt="VulNexis" className="w-6 h-6 rounded" />
        <span className="font-medium text-[13px] tracking-[0.01em]">VulNexis</span>
      </div>

      {/* Workspace switcher — Notion-style plain rows */}
      <div className="px-2 pt-2.5">
        {WORKSPACES.map((w) => (
          <button
            key={w.id}
            onClick={() => onWorkspaceChange(w.id)}
            title={w.hint}
            className={`w-full flex items-center gap-2 px-2 py-[7px] rounded-md text-[13px] transition-colors ${
              workspace === w.id
                ? 'bg-bg-tertiary text-text-primary font-medium'
                : 'text-text-secondary hover:bg-bg-tertiary/70 hover:text-text-primary'
            }`}
          >
            <span className="w-4 text-center text-[13px] leading-none">{w.icon}</span>
            <span className="truncate">{w.label}</span>
          </button>
        ))}
      </div>

      {/* Notion-style ghost "+ New" row */}
      <div className="px-2 pt-2">
        <button
          onClick={isAssistant ? onNewSession : onNewMission}
          className="w-full flex items-center gap-2 px-2 py-[7px] rounded-md text-[13px] text-text-muted hover:bg-bg-tertiary/70 hover:text-text-primary transition-colors"
        >
          <span className="w-4 text-center leading-none opacity-80">＋</span>
          <span className="truncate">{isAssistant ? 'New Chat' : 'New Mission'}</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto mt-1">
        {!isAssistant && (
          <div className="px-2 py-1.5">
            <div className="micro-label px-2 pb-1.5 pt-1">
              {workspace === 'bugbounty' ? 'Programs' : 'Missions'}
            </div>
            {missions.length === 0 ? (
              <div className="px-2 text-xs text-text-disabled italic">
                {workspace === 'bugbounty' ? 'No programs yet' : 'No missions yet'}
              </div>
            ) : (
              <div className="space-y-px">
                {missions.map((m) => (
                  <div key={m.id} className="group relative flex items-center">
                    <button
                      onClick={() => onSelect(m.id)}
                      className={`flex-1 min-w-0 text-left px-2 py-1.5 rounded-md transition-colors ${
                        m.id === activeId
                          ? 'bg-bg-tertiary text-text-primary'
                          : 'text-text-secondary hover:bg-bg-tertiary/70 hover:text-text-primary'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[9px] font-bold font-mono ${kindBadge[missionKind(m)].cls}`}>
                          {kindBadge[missionKind(m)].label}
                        </span>
                        <span className="text-xs font-medium truncate">{m.name}</span>
                      </div>
                      <div className="text-[10px] text-text-muted pl-4">
                        {m.scope.domains.length + m.scope.ips.length + m.scope.wildcards.length} targets
                      </div>
                    </button>
                    <div className="absolute right-1 opacity-0 group-hover:opacity-100 flex items-center bg-bg-tertiary rounded-md">
                      {onEditMission && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onEditMission(m);
                          }}
                          className="text-text-muted hover:text-text-primary text-xs px-1.5 py-1"
                          title="Edit mission"
                        >
                          ✎
                        </button>
                      )}
                      {onDeleteMission && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm('Delete this mission and its sessions?')) {
                              onDeleteMission(m.id);
                            }
                          }}
                          className="text-text-muted hover:text-accent-red text-xs px-1.5 py-1"
                          title="Delete mission"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className={`px-2 py-1.5 ${!isAssistant ? 'border-t border-bordermuted mt-1' : ''}`}>
          <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
            <div className="micro-label">{isAssistant ? 'Chats' : 'Sessions'}</div>
            <button
              onClick={onNewSession}
              className="text-[11px] text-text-muted hover:text-text-primary px-1 rounded hover:bg-bg-tertiary"
              title={isAssistant ? 'New chat' : 'New session'}
            >
              +
            </button>
          </div>
          <div className="space-y-px">
            {sessions.length === 0 ? (
              <div className="px-2 text-xs text-text-disabled italic">
                {isAssistant ? 'No chats yet' : 'No sessions yet'}
              </div>
            ) : (
              sessions.map((s) => (
                <div key={s.id} className="group relative flex items-center">
                  <button
                    onClick={() => onSelectSession(s.id)}
                    className={`flex-1 min-w-0 text-left px-2 py-1.5 rounded-md transition-colors ${
                      s.id === activeSessionId
                        ? 'bg-bg-tertiary text-text-primary'
                        : 'text-text-secondary hover:bg-bg-tertiary/70 hover:text-text-primary'
                    }`}
                    title={s.name}
                  >
                    <div className="flex items-center gap-1.5">
                      {s.goal && (
                        <span className={`text-[10px] ${goalDot[s.goal.state] ?? 'text-text-muted'}`} title={`goal: ${s.goal.state}`}>
                          ◎
                        </span>
                      )}
                      <span className="text-xs font-medium truncate">{s.name}</span>
                    </div>
                    <div className="text-[10px] text-text-muted pl-4">{s.messages.length} messages</div>
                  </button>
                  <button
                    onClick={() => onDeleteSession(s.id)}
                    className="absolute right-1 opacity-0 group-hover:opacity-100 text-text-muted hover:text-accent-red text-xs px-1.5 py-1 bg-bg-tertiary rounded-md"
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
          <div className="px-2 py-1.5 border-t border-bordermuted mt-1">
            <div className="micro-label px-2 pb-1.5 pt-1">Multi-run groups</div>
            <div className="space-y-px">
              {runGroups.map((g) => (
                <button
                  key={g.id}
                  onClick={() => onOpenRunGroup(g.id)}
                  className="w-full text-left px-2 py-1.5 rounded-md text-text-secondary hover:bg-bg-tertiary/70 hover:text-text-primary transition-colors"
                  title={g.prompt}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-accent-purple text-[10px]">⚡</span>
                    <span className="text-xs font-medium truncate">{g.name}</span>
                  </div>
                  <div className="text-[10px] text-text-muted pl-4">{g.runIds.length} runs</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="px-2 py-2 border-t border-bordermuted space-y-px">
        <button
          onClick={onOpenDashboard}
          className="w-full px-2 py-[7px] text-left text-[13px] text-text-secondary hover:bg-bg-tertiary/70 hover:text-text-primary rounded-md transition-colors flex items-center justify-between"
        >
          <span>Sessions Dashboard</span>
          <span className="text-[10px] text-text-muted">all missions</span>
        </button>
        {!isAssistant && (
          <button
            onClick={onOpenTasks}
            className="w-full px-2 py-[7px] text-left text-[13px] text-text-secondary hover:bg-bg-tertiary/70 hover:text-text-primary rounded-md transition-colors flex items-center justify-between"
          >
            <span>Scheduled Tasks</span>
            {taskCount > 0 && <span className="text-[10px] text-accent-amber">{taskCount} active</span>}
          </button>
        )}
        <div className="text-[10px] text-text-disabled px-2 pt-1.5 font-mono">v0.2 — authorized testing only</div>
      </div>
    </aside>
  );
}
