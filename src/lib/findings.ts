import { callLLM } from './llm';
import { addFindings, SEVERITY_ORDER, type Finding, type Mission, type Severity } from './missions';
import type { StoredMsg, Session } from './store';

// Findings extraction: turn a session's tool output into structured findings
// via one LLM call, then merge them into the mission's finding store.

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

function evidenceMaterial(messages: StoredMsg[]): string {
  const tool = messages
    .filter((m) => m.role === 'tool')
    .slice(-10)
    .map((m) => m.text.slice(0, 800));
  const cmds = messages
    .filter((m) => m.role === 'assistant' && m.text.startsWith('$ '))
    .map((m) => m.text.split('\n')[0]);
  return [...cmds, ...tool].join('\n---\n').slice(0, 12000);
}

export async function extractFindings(
  mission: Mission,
  session: Session
): Promise<{ added: Finding[]; updated: number }> {
  const material = evidenceMaterial(session.messages);
  if (!material.trim()) return { added: [], updated: 0 };
  const res = await callLLM([
    {
      role: 'system',
      content:
        'You extract security findings from raw pentest tool output. Reply ONLY with a single JSON array (no markdown, no fences), possibly empty. Each item: {"host":"<ip or domain>","port":"<port/protocol or empty>","vuln":"<short vulnerability or notable finding>","severity":"critical|high|medium|low|info","evidence":"<exact quote from the output supporting it>"}. Only report things the output actually shows. No speculation.',
    },
    {
      role: 'user',
      content: `MISSION SCOPE: ${[...mission.scope.domains, ...mission.scope.ips, ...mission.scope.wildcards].join(', ') || '(none)'}\n\nTOOL OUTPUT:\n${material}`,
    },
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.content.trim());
  } catch {
    const m = res.content.match(/\[[\s\S]*\]/);
    if (!m) return { added: [], updated: 0 };
    parsed = JSON.parse(m[0]);
  }
  if (!Array.isArray(parsed)) return { added: [], updated: 0 };
  const incoming = parsed
    .filter(
      (x: any) =>
        x && typeof x.host === 'string' && typeof x.vuln === 'string' && x.vuln.trim() && x.host.trim()
    )
    .map((x: any) => ({
      missionId: mission.id,
      sessionId: session.id,
      host: String(x.host).trim(),
      port: typeof x.port === 'string' && x.port.trim() ? x.port.trim() : undefined,
      vuln: String(x.vuln).trim(),
      severity: (SEVERITIES.includes(x.severity) ? x.severity : 'info') as Severity,
      evidence: String(x.evidence ?? '').slice(0, 1000),
    }));
  return addFindings(incoming);
}

// AI-guided walkthrough: order findings into an attack-chain reading order
// and explain each stop with an evidence quote. Mirrors ShipChamber's
// Changes Walkthrough (stops, key/context tags), adapted to findings.

export interface WalkthroughStep {
  findingId: string;
  title: string;
  why: string;
  tag: 'key' | 'context' | '';
  quote: string;
}

export async function generateWalkthrough(findings: Finding[]): Promise<WalkthroughStep[]> {
  if (findings.length === 0) return [];
  const list = findings
    .map(
      (f) =>
        `id=${f.id} severity=${f.severity} host=${f.host}${f.port ? ':' + f.port : ''} vuln=${f.vuln}\n  evidence: ${f.evidence || '(none captured)'}`
    )
    .join('\n');
  const res = await callLLM([
    {
      role: 'system',
      content:
        'You are an offensive-security report guide. Reply ONLY with a single JSON object (no markdown): {"steps":[{"findingId":"<id>","title":"<short stop title>","why":"<1-2 sentences on what it means and how it advances the chain>","tag":"key|context or empty string","quote":"<verbatim evidence quote for this finding>"}]}. Order the steps as a reader should follow them: worst severity and chain-critical findings first (recon context, then initial access, then escalation/impact). "key" = drives the rest or carries most risk, "context" = supporting, "" = ordinary.',
    },
    { role: 'user', content: `FINDINGS:\n${list}` },
  ]);
  let parsed: any;
  try {
    parsed = JSON.parse(res.content.trim());
  } catch {
    const m = res.content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Walkthrough model did not return valid JSON.');
    parsed = JSON.parse(m[0]);
  }
  const byId = new Map(findings.map((f) => [f.id, f]));
  const steps = (Array.isArray(parsed?.steps) ? parsed.steps : [])
    .filter((s: any) => byId.has(s?.findingId))
    .map((s: any): WalkthroughStep => ({
      findingId: String(s.findingId),
      title: String(s.title ?? byId.get(s.findingId)!.vuln),
      why: String(s.why ?? ''),
      tag: s.tag === 'key' || s.tag === 'context' ? s.tag : '',
      quote: String(s.quote ?? byId.get(s.findingId)!.evidence ?? ''),
    }));
  if (steps.length === 0) throw new Error('Walkthrough model returned no usable steps.');
  return steps;
}

/** Deterministic fallback order when no walkthrough has been generated yet. */
export function fallbackOrder(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
