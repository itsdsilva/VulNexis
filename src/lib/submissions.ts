// Submission generation, adapted from pentest-ai's bounty report flow: turn an
// oracle-verified finding (candidate allowed but flagged) into a platform-
// ready bug report via one LLM call. The receipt is embedded as the proof
// section so the reader can replay the recipe themselves.

import { callLLM } from './llm';
import type { Finding, Mission, Receipt } from './missions';

export interface Submission {
  title: string;
  markdown: string;
}

function receiptSection(receipt: Receipt | undefined): string {
  if (!receipt) return '';
  const replay =
    receipt.replay.attempts > 0 ? `${receipt.replay.successes}/${receipt.replay.attempts}` : 'n/a';
  return [
    '',
    '## Proof',
    '',
    `- Oracle: \`${receipt.oracleKind}\``,
    `- Replay: ${replay}`,
    `- Verdict: **${receipt.verdict}** (earned by a machine oracle, not asserted by an AI)`,
    '',
    '```',
    (receipt.evidence.diff ?? receipt.evidence.response ?? '').slice(0, 800),
    '```',
    '',
    'Anyone can replay this proof with the attached recipe against the live target — the replay is the trust mechanism, not a signature.',
  ].join('\n');
}

export async function generateSubmission(mission: Mission, finding: Finding): Promise<Submission> {
  const target = finding.host + (finding.port ? ':' + finding.port : '');
  const scopeLine = [...mission.scope.domains, ...mission.scope.ips, ...mission.scope.wildcards].join(', ');
  const verified = finding.status === 'verified';
  const res = await callLLM([
    {
      role: 'system',
      content:
        'You write bug-bounty submissions. Reply ONLY with a JSON object (no markdown fences): {"title":"<report title>","markdown":"<full report in markdown>"}.\n' +
        'Report structure (markdown): Summary, Steps to Reproduce (numbered, exact), Impact, Proof (include the oracle/replay line verbatim if given), Remediation.\n' +
        'Be precise and concise. Never claim impact beyond the evidence. Never fabricate steps not supported by the evidence. Do not include the severity rating in the title.',
    },
    {
      role: 'user',
      content:
        `PROGRAM SCOPE: ${scopeLine || '(none)'}\n` +
        `TARGET: ${target}\n` +
        `FINDING: ${finding.vuln}\n` +
        `SEVERITY: ${finding.severity}${verified ? '' : ' (NOT yet verified by an oracle — state what is proven and what is inferred)'}\n` +
        `BUG CLASS: ${finding.bugClass ?? 'unspecified'}\n` +
        `EVIDENCE: ${finding.evidence || '(none captured)'}\n` +
        `RECEIPT: ${
          finding.receipt
            ? `oracle=${finding.receipt.oracleKind} verdict=${finding.receipt.verdict} replay=${finding.receipt.replay.successes}/${finding.receipt.replay.attempts} proof="${(finding.receipt.evidence.diff ?? '').slice(0, 400)}"`
            : '(none)'
        }`,
    },
  ]);
  let parsed: any;
  try {
    parsed = JSON.parse(res.content.trim());
  } catch {
    const m = res.content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Submission model did not return valid JSON.');
    parsed = JSON.parse(m[0]);
  }
  const title = String(parsed?.title ?? `${finding.vuln} on ${target}`);
  const body = String(parsed?.markdown ?? '').trim();
  if (!body) throw new Error('Submission model returned an empty report.');
  return { title, markdown: body + receiptSection(finding.receipt) };
}

/** Download helper shared by submission + capsule exports. */
export function downloadMarkdown(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
