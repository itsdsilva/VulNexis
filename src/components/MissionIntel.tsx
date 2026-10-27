import { useEffect, useMemo, useRef, useState } from 'react';
import BrowserPanel from './BrowserPanel';
import WalkthroughModal from './WalkthroughModal';
import SubmissionModal from './SubmissionModal';
import {
  type Mission,
  loadFindings,
  findingsFor,
  deleteFinding,
  SEVERITY_STYLE,
  type Finding,
  type FindingStatus,
  type Severity,
} from '../lib/missions';
import type { Session } from '../lib/store';
import { loadSessions } from '../lib/store';
import { extractFindings } from '../lib/findings';
import { verifyFinding } from '../lib/verify';
import { sshExec } from '../lib/ssh';
import { buildCapsule, downloadCapsule, importCapsule, parseCapsule } from '../lib/capsule';
import { collectRecon, reconSummary } from '../lib/recon';
import { buildMissionReport, reportFilename } from '../lib/report';
import { downloadMarkdown } from '../lib/submissions';
import { toast } from '../lib/toast';

interface MissionIntelProps {
  mission: Mission | null;
  session: Session | null;
  connected: boolean;
  onCollapse: () => void;
}

const tabs = ['Overview', 'HTTP', 'Hosts', 'Ports', 'Findings', 'History'] as const;
type Tab = (typeof tabs)[number];

const STATUS_STYLE: Record<FindingStatus, string> = {
  candidate: 'bg-accent-amber/10 text-accent-amber border-accent-amber/30',
  verified: 'bg-accent-green/10 text-accent-green border-accent-green/40',
  unverifiable: 'bg-accent-red/10 text-accent-red border-accent-red/40',
};

const SEVERITY_BAR: Record<Severity, string> = {
  critical: 'bg-accent-red',
  high: 'bg-accent-red/70',
  medium: 'bg-accent-amber',
  low: 'bg-accent-cyan',
  info: 'bg-text-muted',
};

export default function MissionIntel({ mission, session, connected, onCollapse }: MissionIntelProps) {
  const [tab, setTab] = useState<Tab>('Overview');
  const [findings, setFindings] = useState<Finding[]>(() => (mission ? findingsFor(mission.id) : []));
  const [extracting, setExtracting] = useState(false);
  const [extractNote, setExtractNote] = useState('');
  const [walkthroughOpen, setWalkthroughOpen] = useState(false);
  const [submissionFor, setSubmissionFor] = useState<Finding | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [verifyLogs, setVerifyLogs] = useState<Record<string, string[]>>({});
  const [capsuleNote, setCapsuleNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const total = mission
    ? mission.scope.domains.length + mission.scope.ips.length + mission.scope.wildcards.length
    : 0;

  const reloadFindings = () => {
    setFindings(mission ? findingsFor(mission.id) : []);
  };

  // Findings are stored globally and filtered by mission: reload whenever the
  // active mission changes (the panel mounts before a mission is selected).
  useEffect(() => {
    setFindings(mission ? findingsFor(mission.id) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mission?.id]);

  const recon = useMemo(() => collectRecon(session?.messages ?? []), [session?.messages]);
  const reconStats = reconSummary(recon);
  const verifiedCount = findings.filter((f) => f.status === 'verified').length;
  const sevCounts = useMemo(() => {
    const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of findings) c[f.severity]++;
    return c;
  }, [findings]);

  const downloadReport = () => {
    if (!mission) return;
    downloadMarkdown(reportFilename(mission), buildMissionReport(mission, findings, recon));
    toast('Mission report downloaded', 'success');
  };

  const extract = async () => {
    if (!mission || !session || extracting) return;
    setExtracting(true);
    setExtractNote('');
    try {
      const { added, updated } = await extractFindings(mission, session);
      const note =
        added.length === 0 && updated === 0
          ? 'No new findings found in this session.'
          : `+${added.length} new${updated ? `, ${updated} severity raised` : ''}`;
      setExtractNote(note);
      toast(note, added.length ? 'success' : 'info');
      reloadFindings();
    } catch (e) {
      setExtractNote(String(e));
      toast(String(e), 'error');
    } finally {
      setExtracting(false);
    }
  };

  const verify = async (f: Finding) => {
    if (!mission || verifyingId) return;
    setVerifyingId(f.id);
    setVerifyLogs((prev) => ({ ...prev, [f.id]: [] }));
    try {
      const outcome = await verifyFinding(mission, f, {
        connected,
        exec: sshExec,
        onStep: (msg) => setVerifyLogs((prev) => ({ ...prev, [f.id]: [...(prev[f.id] ?? []), msg] })),
      });
      setVerifyLogs((prev) => ({ ...prev, [f.id]: outcome.log }));
      toast(
        `Oracle verdict: ${outcome.verdict}`,
        outcome.verdict === 'verified' ? 'success' : outcome.verdict === 'unverifiable' ? 'error' : 'info'
      );
    } catch (e) {
      setVerifyLogs((prev) => ({ ...prev, [f.id]: [...(prev[f.id] ?? []), String(e)] }));
      toast(String(e), 'error');
    } finally {
      setVerifyingId(null);
      reloadFindings();
    }
  };

  const exportCapsule = async (f: Finding) => {
    const capsule = await buildCapsule(f);
    downloadCapsule(capsule);
    toast('Proof capsule downloaded', 'success');
  };

  const onCapsuleFile = async (file: File) => {
    if (!mission) return;
    setCapsuleNote('');
    try {
      const capsule = parseCapsule(await file.text());
      const result = await importCapsule(capsule, mission.id);
      if (result.ok) {
        setCapsuleNote(`Imported "${result.title}" as candidate — run Verify to re-earn the verdict locally.`);
        toast(`Capsule imported: ${result.title}`, 'success');
        reloadFindings();
      } else {
        setCapsuleNote(result.error);
        toast(result.error, 'error');
      }
    } catch (e) {
      setCapsuleNote(String(e));
      toast(String(e), 'error');
    }
  };

  return (
    <aside className="w-80 bg-bg-secondary border-l border-bordermuted flex flex-col">
      <div className="h-11 border-b border-bordermuted flex items-center justify-between px-3.5">
        <span className="micro-label">Mission Intel</span>
        <button onClick={onCollapse} className="text-text-muted hover:text-text-primary text-xs px-1">
          ×
        </button>
      </div>

      <div className="flex overflow-x-auto border-b border-bordermuted px-1.5">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-2.5 py-2 text-xs whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === t
                ? 'text-text-primary border-accent-cyan font-medium'
                : 'text-text-muted hover:text-text-secondary border-transparent'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {!mission ? (
          <div className="text-xs text-text-disabled italic">No active mission</div>
        ) : tab === 'Overview' ? (
          <div className="space-y-3 text-xs">
            <div className="card p-3">
              <div className="micro-label mb-1.5">Mission</div>
              <div className="font-medium text-[13px]">{mission.name}</div>
              <div className="text-text-muted mt-1">
                Status: {mission.status} · ROE confirmed ✓
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="text-text-secondary">Intensity:</span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                    mission.intensity === 'aggressive'
                      ? 'bg-accent-red/10 text-accent-red border-accent-red/30'
                      : mission.intensity === 'stealth'
                        ? 'bg-accent-green/10 text-accent-green border-accent-green/30'
                        : mission.intensity === 'safe'
                          ? 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30'
                          : 'bg-bg-tertiary text-text-secondary border-bordermuted'
                  }`}
                >
                  {mission.intensity ?? 'normal'}
                </span>
              </div>
            </div>
            <div className="card p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-text-secondary">
                  {(mission.kind ?? 'pentest') === 'bugbounty' ? 'Bug bounty dashboard' : 'Assessment dashboard'}
                </span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                    (mission.kind ?? 'pentest') === 'bugbounty'
                      ? 'bg-accent-purple/10 text-accent-purple border-accent-purple/30'
                      : 'bg-bg-secondary text-text-secondary border-bordermuted'
                  }`}
                >
                  {mission.kind ?? 'pentest'}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 mb-2.5">
                <div className="bg-bg-tertiary rounded-lg p-2 text-center border border-bordermuted">
                  <div className="text-lg font-semibold tabular-nums">{findings.length}</div>
                  <div className="text-[10px] text-text-muted">findings</div>
                </div>
                <div className="bg-bg-tertiary rounded-lg p-2 text-center border border-bordermuted">
                  <div className="text-lg font-semibold tabular-nums text-accent-green">{verifiedCount}</div>
                  <div className="text-[10px] text-text-muted">verified</div>
                </div>
                <div className="bg-bg-tertiary rounded-lg p-2 text-center border border-bordermuted">
                  <div className="text-lg font-semibold tabular-nums text-accent-amber">{findings.length - verifiedCount}</div>
                  <div className="text-[10px] text-text-muted">candidate</div>
                </div>
              </div>
              <div className="flex h-1.5 rounded overflow-hidden bg-bg-secondary mb-1">
                {(Object.keys(sevCounts) as Severity[]).map((s) =>
                  sevCounts[s] > 0 ? (
                    <div
                      key={s}
                      className={SEVERITY_BAR[s]}
                      style={{ width: `${(sevCounts[s] / Math.max(findings.length, 1)) * 100}%` }}
                      title={`${sevCounts[s]} ${s}`}
                    />
                  ) : null
                )}
              </div>
              <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-text-secondary">
                {(Object.keys(sevCounts) as Severity[]).map((s) => (
                  <span key={s}>
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${SEVERITY_BAR[s]}`} />
                    {s} {sevCounts[s]}
                  </span>
                ))}
              </div>
              <div className="mt-2 pt-2 border-t border-bordermuted flex items-center justify-between">
                <span className="text-text-muted">
                  Recon: {reconStats.hosts} host{reconStats.hosts === 1 ? '' : 's'} · {reconStats.ports} port
                  {reconStats.ports === 1 ? '' : 's'} · {reconStats.endpoints} URL{reconStats.endpoints === 1 ? '' : 's'}
                </span>
                <button
                  onClick={downloadReport}
                  disabled={findings.length === 0 && reconStats.hosts === 0}
                  className="px-2.5 py-1 rounded-full border border-accent-cyan/30 text-accent-cyan text-[11px] hover:bg-accent-cyan/10 disabled:opacity-40"
                  title="Download a deterministic markdown report of every finding and the recon summary"
                >
                  Report .md
                </button>
              </div>
            </div>
            <div className="card p-3">
              <div className="micro-label mb-1.5">Scope summary</div>
              <div>{total} in-scope targets</div>
              <div className="text-accent-red/80">{mission.scope.outOfScope.length} blocked targets</div>
              {mission.scope.domains.map((d) => (
                <div key={d} className="font-mono text-[10px] mt-1 text-accent-green/80">✓ {d}</div>
              ))}
              {mission.scope.ips.map((ip) => (
                <div key={ip} className="font-mono text-[10px] text-accent-green/80">✓ {ip}</div>
              ))}
              {mission.scope.wildcards.map((w) => (
                <div key={w} className="font-mono text-[10px] text-accent-green/80">✓ {w}</div>
              ))}
            </div>
          </div>
        ) : tab === 'HTTP' ? (
          <div className="space-y-2">
            <BrowserPanel mission={mission} suggestedUrls={recon.endpoints.map((e) => e.url)} />
            {recon.endpoints.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-text-secondary">
                  Discovered endpoints
                </div>
                <div className="card divide-y divide-bordermuted max-h-64 overflow-y-auto">
                  {recon.endpoints.map((ep) => (
                    <div key={ep.url} className="px-2 py-1 flex items-center gap-2">
                      <span className="font-mono text-[10px] truncate flex-1">{ep.url}</span>
                      {ep.status !== undefined && (
                        <span
                          className={`text-[10px] font-mono ${
                            ep.status >= 500
                              ? 'text-accent-red'
                              : ep.status >= 400
                                ? 'text-accent-amber'
                                : 'text-accent-green'
                          }`}
                        >
                          {ep.status}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : tab === 'Hosts' ? (
          recon.hosts.length === 0 ? (
            <div className="text-text-secondary/50 italic">
              No hosts parsed yet. Run nmap/httpx in a session — results appear here automatically.
            </div>
          ) : (
            <div className="space-y-2">
              {recon.hosts.map((h) => (
                <div key={h.host} className="card p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] flex-1 truncate">{h.host}</span>
                    <span className="text-[10px] text-text-secondary">
                      {h.ports.length} port{h.ports.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  {h.ips.length > 0 && (
                    <div className="text-[10px] text-text-secondary font-mono">{h.ips.join(', ')}</div>
                  )}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {h.ports.map((p) => (
                      <span
                        key={`${p.proto}-${p.port}`}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-bg-secondary font-mono"
                        title={p.version ?? p.service}
                      >
                        {p.port}/{p.proto} {p.service}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : tab === 'Ports' ? (
          recon.ports.length === 0 ? (
            <div className="text-text-secondary/50 italic">
              No open ports parsed yet. Run nmap with service detection to populate this view.
            </div>
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full text-[10px]">
                <thead className="bg-bg-tertiary text-text-secondary">
                  <tr>
                    <th className="text-left px-2 py-1 font-medium">Host</th>
                    <th className="text-left px-2 py-1 font-medium">Port</th>
                    <th className="text-left px-2 py-1 font-medium">Service</th>
                    <th className="text-left px-2 py-1 font-medium">Version</th>
                  </tr>
                </thead>
                <tbody>
                  {recon.ports.map((p) => (
                    <tr key={`${p.host}-${p.proto}-${p.port}`} className="border-t border-border">
                      <td className="px-2 py-1 font-mono truncate max-w-[90px]">{p.host}</td>
                      <td className="px-2 py-1 font-mono">
                        {p.port}/{p.proto}
                      </td>
                      <td className="px-2 py-1">{p.service}</td>
                      <td className="px-2 py-1 text-text-secondary truncate max-w-[110px]">
                        {p.version ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : tab === 'Findings' ? (
          <div className="space-y-2 text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={extract}
                disabled={extracting || !session || session.messages.length === 0}
                className="px-2.5 py-1 rounded-full border border-accent-cyan/30 text-accent-cyan text-[11px] hover:bg-accent-cyan/10 disabled:opacity-40"
                title="Extract findings from the current session's tool output with one LLM call"
              >
                {extracting ? 'Extracting…' : 'Extract findings'}
              </button>
              <button
                onClick={() => {
                  reloadFindings();
                  setWalkthroughOpen(true);
                }}
                disabled={findings.length === 0}
                className="px-2.5 py-1 rounded-full border border-accent-purple/30 text-accent-purple text-[11px] hover:bg-accent-purple/10 disabled:opacity-40"
                title="AI-guided step-by-step walkthrough of the findings, ordered by severity and attack chain"
              >
                Walkthrough
              </button>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={!mission}
                className="px-2.5 py-1 rounded-full border border-bordermuted text-text-secondary text-[11px] hover:text-text-primary hover:border-border disabled:opacity-40"
                title="Import a proof capsule JSON — integrity-checked, re-verified locally before the verdict is trusted"
              >
                Import capsule
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onCapsuleFile(file);
                  e.target.value = '';
                }}
              />
              {capsuleNote && <div className="w-full text-[10px] text-text-muted">{capsuleNote}</div>}
              {extractNote && <div className="w-full text-[10px] text-text-muted">{extractNote}</div>}
            </div>
            {findings.length === 0 ? (
              <div className="text-text-secondary/50 italic">
                No findings yet. Run tools in a session, then extract findings from it.
              </div>
            ) : (
              findings
                .slice()
                .sort((a, b) => a.host.localeCompare(b.host))
                .map((f) => {
                  const status: FindingStatus = f.status ?? 'candidate';
                  const log = verifyLogs[f.id] ?? [];
                  return (
                    <div key={f.id} className="card p-2.5 group">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${SEVERITY_STYLE[f.severity]}`}>
                          {f.severity}
                        </span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${STATUS_STYLE[status]}`}>
                          {status === 'verified' ? '✓ verified' : status}
                        </span>
                        <span className="font-mono text-[11px] truncate flex-1">
                          {f.host}
                          {f.port ? `:${f.port}` : ''}
                        </span>
                        <button
                          onClick={() => {
                            deleteFinding(f.id);
                            reloadFindings();
                          }}
                          className="opacity-0 group-hover:opacity-100 text-text-secondary hover:text-accent-red"
                          title="Delete finding"
                        >
                          ×
                        </button>
                      </div>
                      <div className="mt-1">{f.vuln}</div>
                      {f.evidence && (
                        <div className="mt-1 text-[10px] text-text-muted font-mono whitespace-pre-wrap break-words max-h-16 overflow-y-auto">
                          {f.evidence}
                        </div>
                      )}
                      {f.receipt && (
                        <div className="mt-1 text-[10px] text-text-secondary border-l-2 border-accent-green/40 pl-2">
                          <span className="font-mono">{f.receipt.oracleKind}</span> ·{' '}
                          {f.receipt.replay.successes}/{f.receipt.replay.attempts} replay ·{' '}
                          <span
                            className={f.receipt.verdict === 'verified' ? 'text-accent-green' : 'text-accent-amber'}
                          >
                            {f.receipt.verdict}
                          </span>
                          {f.receipt.evidence.diff && (
                            <div className="mt-0.5 text-text-muted break-words max-h-12 overflow-y-auto">
                              {f.receipt.evidence.diff}
                            </div>
                          )}
                        </div>
                      )}
                      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap opacity-100 md:opacity-70 group-hover:opacity-100">
                        <button
                          onClick={() => void verify(f)}
                          disabled={verifyingId !== null}
                          className="px-2 py-0.5 rounded-full border border-accent-cyan/30 text-accent-cyan text-[11px] hover:bg-accent-cyan/10 disabled:opacity-40"
                          title={
                            connected
                              ? 'Run the machine oracle on your Kali box: re-prove this finding or stay candidate'
                              : 'Connect Kali first — the oracle runs real commands against the target'
                          }
                        >
                          {verifyingId === f.id ? 'Verifying…' : 'Verify'}
                        </button>
                        <button
                          onClick={() => void exportCapsule(f)}
                          className="px-2 py-0.5 rounded-full border border-bordermuted text-text-secondary text-[11px] hover:text-text-primary hover:border-border"
                          title="Export a portable proof capsule (finding + recipe + receipt + integrity digest)"
                        >
                          Capsule
                        </button>
                        <button
                          onClick={() => setSubmissionFor(f)}
                          className="px-2 py-0.5 rounded-full border border-accent-purple/30 text-accent-purple text-[11px] hover:bg-accent-purple/10"
                          title="Generate a platform-ready bug bounty report"
                        >
                          Submit
                        </button>
                      </div>
                      {log.length > 0 && (
                        <div className="mt-1.5 text-[10px] font-mono text-text-muted border border-bordermuted rounded-md p-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-words">
                          {log.join('\n')}
                        </div>
                      )}
                    </div>
                  );
                })
            )}
          </div>
        ) : tab === 'History' ? (
          (() => {
            const list = mission
              ? loadSessions()
                  .filter((s) => s.missionId === mission.id)
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              : [];
            return list.length === 0 ? (
              <div className="text-text-secondary/50 italic">No sessions recorded for this mission yet.</div>
            ) : (
              <div className="space-y-1.5">
                {list.map((s) => (
                  <div key={s.id} className="card p-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] truncate flex-1 font-medium">{s.name}</span>
                      <span className="text-[10px] text-text-muted">{s.messages.length} msg</span>
                    </div>
                    <div className="text-[10px] text-text-disabled">
                      {s.agent} · {new Date(s.updatedAt).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()
        ) : null}
      </div>

      {walkthroughOpen && mission && (
        <WalkthroughModal
          missionName={mission.name}
          findings={loadFindings().filter((f) => f.missionId === mission.id)}
          onClose={() => setWalkthroughOpen(false)}
        />
      )}

      {submissionFor && mission && (
        <SubmissionModal
          mission={mission}
          finding={submissionFor}
          onClose={() => setSubmissionFor(null)}
        />
      )}
    </aside>
  );
}
