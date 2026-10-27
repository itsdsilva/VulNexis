import { useMemo, useRef, useState } from 'react';
import {
  BUILTINS,
  importPlaybook,
  parsePlaybook,
  phasePrompt,
  planPhases,
  resolveInputs,
  type Playbook,
} from '../lib/playbooks';
import { findingsFor, type Finding, type Mission } from '../lib/missions';

interface PlaybookModalProps {
  mission: Mission;
  /** Runs one agent turn in the active session with this user prompt. */
  runPrompt: (text: string) => Promise<void>;
  onClose: () => void;
}

type PhaseState = 'pending' | 'running' | 'done' | 'skipped' | 'waiting';

const STATE_STYLE: Record<PhaseState, string> = {
  pending: 'text-text-secondary',
  running: 'text-accent-cyan',
  done: 'text-accent-green',
  skipped: 'text-text-muted line-through',
  waiting: 'text-accent-amber',
};

const STATE_LABEL: Record<PhaseState, string> = {
  pending: 'pending',
  running: 'running…',
  done: 'done',
  skipped: 'skipped',
  waiting: 'waiting for you',
};

export default function PlaybookModal({ mission, runPrompt, onClose }: PlaybookModalProps) {
  const [playbooks, setPlaybooks] = useState<Playbook[]>(BUILTINS);
  const [selected, setSelected] = useState<Playbook | null>(BUILTINS[0] ?? null);
  const [inputValues, setInputValues] = useState<Record<string, Record<string, string>>>({});
  const [phaseStates, setPhaseStates] = useState<Record<string, Record<string, PhaseState>>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const findings: Finding[] = useMemo(() => findingsFor(mission.id), [mission.id]);
  const plan = useMemo(
    () => (selected ? planPhases(selected, findings) : []),
    [selected, findings]
  );
  const inputs = selected?.inputs ?? {};
  const currentInputs = selected ? inputValues[selected.name] ?? {} : {};

  const setInput = (key: string, value: string) => {
    if (!selected) return;
    setInputValues((prev) => ({ ...prev, [selected.name]: { ...prev[selected.name], [key]: value } }));
  };

  const setPhaseState = (pbName: string, phaseId: string, state: PhaseState) => {
    setPhaseStates((prev) => ({ ...prev, [pbName]: { ...prev[pbName], [phaseId]: state } }));
  };

  const onImportFile = async (file: File) => {
    setError('');
    try {
      const pb = importPlaybook(await file.text());
      setPlaybooks((prev) => [...prev.filter((p) => p.name !== pb.name), pb]);
      setSelected(pb);
      setPhaseStates((prev) => ({ ...prev, [pb.name]: {} }));
    } catch (e) {
      setError(String(e));
    }
  };

  const exportSelected = () => {
    if (!selected) return;
    try {
      parsePlaybook(selected); // validate shape before sharing
    } catch (e) {
      setError(String(e));
      return;
    }
    const blob = new Blob([JSON.stringify(selected, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selected.name}.playbook.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const run = async () => {
    if (!selected || running) return;
    setError('');
    let resolved: Record<string, string>;
    try {
      resolved = resolveInputs(selected, currentInputs);
    } catch (e) {
      setError(String(e));
      return;
    }
    setRunning(true);
    const states = phaseStates[selected.name] ?? {};
    try {
      for (const { phase, willRun } of plan) {
        if (!willRun) {
          setPhaseState(selected.name, phase.id, 'skipped');
          states[phase.id] = 'skipped';
          continue;
        }
        // Stop at manual gates or anything the user already handled this run
        if (phase.manual && states[phase.id] !== 'done') {
          setPhaseState(selected.name, phase.id, 'waiting');
          states[phase.id] = 'waiting';
          setError(`Phase "${phase.id}" is a manual gate — review the checklist, then mark it done to continue.`);
          return;
        }
        if (states[phase.id] === 'done') continue;
        setPhaseState(selected.name, phase.id, 'running');
        states[phase.id] = 'running';
        try {
          await runPrompt(phasePrompt(selected, phase, resolved));
          setPhaseState(selected.name, phase.id, 'done');
          states[phase.id] = 'done';
        } catch (e) {
          setPhaseState(selected.name, phase.id, 'pending');
          setError(`Phase "${phase.id}" failed: ${String(e)}`);
          return;
        }
      }
    } finally {
      setRunning(false);
    }
  };

  const markManualDone = () => {
    if (!selected) return;
    const waiting = plan.find((p) => (phaseStates[selected.name] ?? {})[p.phase.id] === 'waiting');
    if (waiting) setPhaseState(selected.name, waiting.phase.id, 'done');
    void run(); // continue with the remaining phases
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-bg-elevated border border-border rounded-lg shadow-pop w-[720px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-11 border-b border-bordermuted flex items-center px-4 gap-2">
          <span className="font-medium text-sm">Playbooks</span>
          <span className="text-xs text-text-secondary">· {mission.name}</span>
          <div className="flex-1" />
          <button onClick={() => fileRef.current?.click()} className="text-xs text-text-secondary hover:text-text-primary" title="Import a playbook JSON">
            Import
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportFile(f);
              e.target.value = '';
            }}
          />
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-sm px-1">
            ×
          </button>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-56 border-r border-border overflow-y-auto p-2 space-y-1">
            {playbooks.map((pb) => (
              <button
                key={pb.name}
                onClick={() => {
                  setSelected(pb);
                  setError('');
                }}
                className={`w-full text-left px-2 py-1.5 rounded text-xs border ${
                  selected?.name === pb.name
                    ? 'border-accent-cyan/60 bg-accent-cyan/10 text-accent-cyan'
                    : 'border-transparent hover:bg-bg-tertiary text-text-secondary'
                }`}
              >
                <div className="font-medium">{pb.name}</div>
                <div className="text-[10px] text-text-muted">
                  {pb.phases.length} phases · {pb.intensity}
                </div>
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
            {!selected ? (
              <div className="text-text-secondary/50 italic">Select a playbook.</div>
            ) : (
              <>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{selected.name}</span>
                    <span className="text-[10px] text-text-muted">v{selected.version}</span>
                    <button onClick={exportSelected} className="text-[10px] text-text-secondary hover:text-text-primary underline">
                      export
                    </button>
                  </div>
                  <div className="text-text-secondary mt-1">{selected.description}</div>
                </div>

                {Object.keys(inputs).length > 0 && (
                  <div className="space-y-2">
                    {Object.values(inputs).map((spec) => (
                      <div key={spec.name}>
                        <label className="text-text-secondary">
                          {spec.prompt || spec.name}
                          {spec.required && <span className="text-accent-red"> *</span>}
                        </label>
                        <input
                          value={currentInputs[spec.name] ?? ''}
                          onChange={(e) => setInput(spec.name, e.target.value)}
                          placeholder={spec.default || spec.name}
                          className="w-full mt-0.5 px-2 py-1 bg-bg-tertiary border border-border rounded font-mono"
                        />
                      </div>
                    ))}
                  </div>
                )}

                <div>
                  <div className="text-text-secondary mb-1">Phase plan</div>
                  <div className="space-y-1">
                    {plan.map(({ phase, willRun, reason }) => {
                      const st = (phaseStates[selected.name] ?? {})[phase.id] ?? 'pending';
                      return (
                        <div key={phase.id} className="border border-border rounded px-2 py-1.5 bg-bg-secondary">
                          <div className="flex items-center gap-2">
                            <span className={`font-mono ${STATE_STYLE[st]}`}>{STATE_LABEL[st]}</span>
                            <span className="font-medium">{phase.id}</span>
                            {phase.manual && (
                              <span className="text-[10px] px-1 rounded border border-accent-amber/40 text-accent-amber">manual gate</span>
                            )}
                            {phase.condition && !willRun && (
                              <span className="text-[10px] text-text-muted truncate" title={reason}>
                                {reason}
                              </span>
                            )}
                          </div>
                          {phase.tools.length > 0 && (
                            <div className="text-[10px] text-text-muted font-mono mt-0.5">{phase.tools.join(' · ')}</div>
                          )}
                          {phase.checklist.length > 0 && (
                            <ul className="mt-1 space-y-0.5">
                              {phase.checklist.map((c, i) => (
                                <li key={i} className="text-[10px] text-text-secondary">– {c}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {error && <div className="text-accent-red">{error}</div>}
              </>
            )}
          </div>
        </div>

        <div className="h-12 border-t border-border flex items-center justify-end px-4 gap-2">
          {selected && (phaseStates[selected.name] ?? {}).waiting === 'waiting' && (
            <button
              onClick={markManualDone}
              className="px-3 py-1.5 text-xs border border-accent-amber/40 text-accent-amber rounded hover:bg-accent-amber/10"
            >
              Mark manual phase done →
            </button>
          )}
          <button
            onClick={run}
            disabled={running || !selected || !Object.values(inputs).every((s) => !s.required || (currentInputs[s.name] ?? s.default ?? '').trim())}
            className="px-4 py-1.5 text-xs font-semibold bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/40 rounded hover:bg-accent-cyan/25 disabled:opacity-40"
          >
            {running ? 'Running…' : 'Run playbook'}
          </button>
        </div>
      </div>
    </div>
  );
}
