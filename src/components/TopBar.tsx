import { useState } from 'react';
import SettingsModal from './SettingsModal';
import { type Mission } from '../lib/missions';
import type { Workspace } from '../lib/store';

interface TopBarProps {
  mission: Mission | null;
  workspace: Workspace;
  connected: boolean;
  onConnectionChange: (connected: boolean) => void;
  usage: { total: number; calls: number; cost: number };
}

const WORKSPACE_LABEL: Record<Workspace, string> = {
  assistant: 'Assistant — ask me anything',
  pentest: 'Pentest',
  bugbounty: 'Bug Bounty',
};

export default function TopBar({ mission, workspace, connected, onConnectionChange, usage }: TopBarProps) {
  const [open, setOpen] = useState(false);

  const targetCount = mission
    ? mission.scope.domains.length + mission.scope.ips.length + mission.scope.wildcards.length
    : 0;

  return (
    <>
      <header className="h-12 bg-bg-secondary/90 backdrop-blur border-b border-bordermuted flex items-center px-4 gap-4 select-none">
        <div className="flex items-center gap-2.5 min-w-0">
          <img src="/logo_32.png" alt="VulNexis" className="w-7 h-7 rounded-md shadow-card" />
          <div className="leading-none">
            <div className="font-semibold text-[13px] tracking-[0.02em]">VulNexis</div>
            <div className="micro-label mt-0.5">Security Operations</div>
          </div>
        </div>

        <div className="flex-1 flex items-center gap-3 text-xs text-text-secondary min-w-0">
          <span
            className={`chip ${connected ? 'border-accent-green/30 text-accent-green' : 'border-accent-red/30 text-accent-red'}`}
            title={connected ? 'Kali VM reachable over SSH' : 'Connect a Kali VM in Settings'}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-accent-green' : 'bg-accent-red'}`}></span>
            Kali {connected ? 'online' : 'offline'}
          </span>
          <span className="h-4 w-px bg-bordermuted"></span>
          <span className="truncate">
            {mission ? (
              <>
                <span className="text-text-muted">Mission&nbsp;·&nbsp;</span>
                <span className="text-text-primary font-medium">{mission.name}</span>
                <span className="text-text-muted"> — {targetCount} targets</span>
              </>
            ) : (
              <span className="text-text-muted">{WORKSPACE_LABEL[workspace]}</span>
            )}
          </span>
          <span className="h-4 w-px bg-bordermuted"></span>
          <span className="chip font-mono text-[10px]">
            ${usage.cost.toFixed(4)} · {usage.total.toLocaleString()} tok · {usage.calls} calls
          </span>
        </div>

        <button
          onClick={() => setOpen(true)}
          className="px-3.5 py-1.5 text-xs font-medium text-text-secondary border border-bordermuted rounded-full hover:text-text-primary hover:border-border hover:bg-bg-tertiary"
        >
          Settings
        </button>
      </header>
      {open && <SettingsModal onClose={() => setOpen(false)} onConnectionChange={onConnectionChange} />}
    </>
  );
}
