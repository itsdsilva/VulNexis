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
      <header className="h-11 bg-bg-primary flex items-center px-3 gap-3 select-none shrink-0">
        <div className="flex-1 flex items-center gap-2.5 text-xs min-w-0">
          <span className="flex items-center gap-1.5" title={connected ? 'Kali VM reachable over SSH' : 'Connect a Kali VM in Settings'}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-accent-green' : 'bg-accent-red'}`}></span>
            <span className={connected ? 'text-accent-green' : 'text-accent-red'}>Kali {connected ? 'online' : 'offline'}</span>
          </span>
          <span className="h-4 w-px bg-bordermuted"></span>
          <span className="truncate text-text-muted">
            {mission ? (
              <>
                <span>Mission</span>
                <span className="mx-1.5 text-text-disabled">/</span>
                <span className="text-text-primary font-medium">{mission.name}</span>
                <span> — {targetCount} targets</span>
              </>
            ) : (
              <span>{WORKSPACE_LABEL[workspace]}</span>
            )}
          </span>
          <span className="h-4 w-px bg-bordermuted"></span>
          <span className="font-mono text-[10px] text-text-muted whitespace-nowrap">
            ${usage.cost.toFixed(4)} · {usage.total.toLocaleString()} tok · {usage.calls} calls
          </span>
        </div>

        <button
          onClick={() => setOpen(true)}
          className="px-2.5 py-1.5 text-xs text-text-secondary rounded-md hover:bg-bg-tertiary hover:text-text-primary"
        >
          Settings
        </button>
      </header>
      {open && <SettingsModal onClose={() => setOpen(false)} onConnectionChange={onConnectionChange} />}
    </>
  );
}
