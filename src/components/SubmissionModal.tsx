import { useState } from 'react';
import Markdown from './Markdown';
import { generateSubmission, downloadMarkdown, type Submission } from '../lib/submissions';
import { SEVERITY_STYLE, type Finding, type Mission } from '../lib/missions';

interface SubmissionModalProps {
  mission: Mission;
  finding: Finding;
  onClose: () => void;
}

export default function SubmissionModal({ mission, finding, onClose }: SubmissionModalProps) {
  const [sub, setSub] = useState<Submission | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    setGenerating(true);
    setError('');
    try {
      const result = await generateSubmission(mission, finding);
      setSub(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  };

  const copy = async () => {
    if (!sub) return;
    await navigator.clipboard.writeText(sub.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const target = finding.host + (finding.port ? ':' + finding.port : '');

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-bg-primary border border-border rounded-lg w-[680px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-11 border-b border-border flex items-center px-4 gap-2">
          <span className="font-medium text-sm">Bug Bounty Submission</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${SEVERITY_STYLE[finding.severity]}`}>
            {finding.severity}
          </span>
          {finding.status === 'verified' ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded border bg-accent-green/10 text-accent-green border-accent-green/40">
              ✓ oracle verified
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded border bg-accent-amber/10 text-accent-amber border-accent-amber/30">
              candidate — unverified
            </span>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-sm px-1">
            ×
          </button>
        </div>

        <div className="px-4 py-2 border-b border-border flex items-center gap-2 text-xs">
          <button
            onClick={generate}
            disabled={generating}
            className="px-2 py-1 rounded border border-accent-cyan/40 text-accent-cyan hover:bg-accent-cyan/10 disabled:opacity-50"
          >
            {generating ? 'Writing…' : sub ? 'Regenerate' : 'Generate report'}
          </button>
          <span className="text-text-secondary font-mono truncate">{target}</span>
          {sub && (
            <>
              <button onClick={copy} className="px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary">
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
              <button
                onClick={() => downloadMarkdown(`${sub.title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'submission'}.md`, sub.markdown)}
                className="px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary"
              >
                Download .md
              </button>
            </>
          )}
          {error && <span className="text-accent-red truncate">{error}</span>}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {!sub ? (
            <div className="text-sm text-text-secondary">
              Generates a platform-ready report from the finding and its proof receipt. Verified findings include the
              oracle evidence so triage can replay the proof themselves.
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-sm font-semibold">{sub.title}</div>
              <div className="border border-border rounded-lg p-3 bg-bg-secondary">
                <Markdown text={sub.markdown} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
