import { useState } from 'react';
import {
  generateWalkthrough,
  fallbackOrder,
  type WalkthroughStep,
} from '../lib/findings';
import { SEVERITY_STYLE, type Finding } from '../lib/missions';

interface WalkthroughModalProps {
  missionName: string;
  findings: Finding[];
  onClose: () => void;
}

const tagStyle: Record<WalkthroughStep['tag'], string> = {
  key: 'bg-accent-red/10 text-accent-red border-accent-red/40',
  context: 'bg-bg-tertiary text-text-secondary border-border',
  '': '',
};

export default function WalkthroughModal({
  missionName,
  findings,
  onClose,
}: WalkthroughModalProps) {
  const [steps, setSteps] = useState<WalkthroughStep[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [gen, setGen] = useState(false);
  const [error, setError] = useState('');

  const byId = new Map(findings.map((f) => [f.id, f]));
  const items: { finding: Finding; step?: WalkthroughStep }[] = steps
    ? steps.flatMap((s) => {
        const finding = byId.get(s.findingId);
        return finding ? [{ finding, step: s }] : [];
      })
    : fallbackOrder(findings).map((f) => ({ finding: f }));
  const current = items[idx] ?? null;

  const generate = async () => {
    setGen(true);
    setError('');
    try {
      const result = await generateWalkthrough(findings);
      setSteps(result);
      setIdx(0);
    } catch (e) {
      setError(String(e));
    } finally {
      setGen(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-bg-primary border border-border rounded-lg w-[640px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-11 border-b border-border flex items-center px-4 gap-2">
          <span className="font-medium text-sm">Findings Walkthrough</span>
          <span className="text-xs text-text-secondary">· {missionName}</span>
          <div className="flex-1" />
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-sm px-1">
            ×
          </button>
        </div>

        {findings.length === 0 ? (
          <div className="flex-1 p-6 text-sm text-text-secondary">
            No findings extracted for this mission yet. Open <span className="text-accent-cyan">Findings</span> and run
            "Extract findings" on a session with tool output first.
          </div>
        ) : (
          <>
            <div className="px-4 py-2 border-b border-border flex items-center gap-2 text-xs">
              <button
                onClick={generate}
                disabled={gen}
                className="px-2 py-1 rounded border border-accent-cyan/40 text-accent-cyan hover:bg-accent-cyan/10 disabled:opacity-50"
              >
                {gen ? 'Generating…' : steps ? 'Regenerate walkthrough' : 'Generate walkthrough'}
              </button>
              {steps ? (
                <span className="text-text-secondary">AI-ordered · {steps.length} stops</span>
              ) : (
                <span className="text-text-secondary">severity order · generate for AI attack-chain order</span>
              )}
              {error && <span className="text-accent-red truncate">{error}</span>}
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {current && (
                <>
                  <div className="flex items-center gap-2">
                    {current.step?.tag && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${tagStyle[current.step.tag]}`}>
                        {current.step.tag === 'key' ? 'Key finding' : 'Context'}
                      </span>
                    )}
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border ${SEVERITY_STYLE[current.finding.severity]}`}
                    >
                      {current.finding.severity}
                    </span>
                    <span className="text-sm font-medium">
                      {current.step?.title ?? current.finding.vuln}
                    </span>
                  </div>
                  <div className="text-xs text-text-secondary font-mono">
                    {current.finding.host}
                    {current.finding.port ? `:${current.finding.port}` : ''}
                  </div>
                  {current.step?.why && (
                    <div className="text-sm border border-border rounded-lg px-3 py-2 bg-bg-secondary">
                      {current.step.why}
                    </div>
                  )}
                  {!current.step && <div className="text-sm text-text-secondary">{current.finding.vuln}</div>}
                  {current.finding.evidence && (
                    <div className="border border-border rounded-lg px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1">evidence</div>
                      <div className="text-xs font-mono whitespace-pre-wrap break-words">{current.finding.evidence}</div>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="h-11 border-t border-border flex items-center px-4 gap-2">
              <button
                onClick={() => setIdx((i) => Math.max(0, i - 1))}
                disabled={idx === 0}
                className="px-2 py-1 text-xs border border-border rounded disabled:opacity-40 hover:bg-bg-tertiary"
              >
                ← Prev
              </button>
              <span className="text-xs text-text-secondary">
                Step {idx + 1} of {items.length}
              </span>
              <div className="flex-1 flex gap-1 justify-center">
                {items.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setIdx(i)}
                    className={`w-2 h-2 rounded-full ${i === idx ? 'bg-accent-cyan' : 'bg-bg-tertiary hover:bg-border'}`}
                    title={`Step ${i + 1}`}
                  />
                ))}
              </div>
              <button
                onClick={() => setIdx((i) => Math.min(items.length - 1, i + 1))}
                disabled={idx >= items.length - 1}
                className="px-2 py-1 text-xs border border-border rounded disabled:opacity-40 hover:bg-bg-tertiary"
              >
                Next →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
