import { useState } from 'react';
import { sshExec } from '../lib/ssh';

interface ShellPanelProps {
  onCollapse: () => void;
}

interface ShellLine {
  type: 'cmd' | 'out' | 'err';
  text: string;
}

export default function ShellPanel({ onCollapse }: ShellPanelProps) {
  const [lines, setLines] = useState<ShellLine[]>([
    { type: 'out', text: 'VULNEXIS Shell Console — connect to Kali VM in Settings first.' },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);

  const run = async () => {
    const cmd = input.trim();
    if (!cmd || busy) return;
    setBusy(true);
    setInput('');
    setHistory((h) => [...h, cmd]);
    setHistIdx(-1);
    setLines((l) => [...l, { type: 'cmd', text: cmd }]);
    try {
      const out = await sshExec(cmd);
      setLines((l) => [...l, { type: 'out', text: out.trim() || '(no output)' }]);
    } catch (e: any) {
      setLines((l) => [...l, { type: 'err', text: String(e) }]);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      run();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const idx = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setInput(history[idx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx === -1) return;
      const idx = histIdx + 1;
      if (idx >= history.length) {
        setHistIdx(-1);
        setInput('');
      } else {
        setHistIdx(idx);
        setInput(history[idx]);
      }
    }
  };

  return (
    <div className="h-64 bg-bg-secondary border-t border-bordermuted flex flex-col shrink-0">
      <div className="h-9 border-b border-bordermuted flex items-center justify-between px-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">Kali Shell</span>
          <span className="text-xs text-text-muted">manual mode</span>
        </div>
        <div className="flex items-center gap-2">
          {busy && <span className="text-xs text-accent-amber">running…</span>}
          <button onClick={onCollapse} className="text-text-muted hover:text-text-primary text-xs px-1">×
          </button>
        </div>
      </div>

      <div className="flex-1 bg-[#141414] p-2 overflow-y-auto font-mono text-xs">
        {lines.map((line, i) => (
          <div
            key={i}
            className={
              line.type === 'cmd'
                ? 'text-accent-cyan'
                : line.type === 'err'
                ? 'text-accent-red'
                : 'text-text-secondary whitespace-pre-wrap'
            }
          >
            {line.type === 'cmd' ? `$ ${line.text}` : line.text}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-bordermuted px-2 py-1.5">
        <span className="text-accent-cyan font-mono text-xs">$</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="type a command (e.g. whoami) and press Enter"
          className="flex-1 bg-transparent outline-none font-mono text-xs text-text-primary placeholder:text-text-disabled"
        />
      </div>
    </div>
  );
}
