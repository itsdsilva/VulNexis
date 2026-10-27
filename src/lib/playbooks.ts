// Playbook engine, adapted from pentest-ai (engine/playbook.py): a playbook
// encodes a methodology as an ordered list of phases, each with tools to run,
// optional gating conditions against the findings, and dependencies on earlier
// phases. Playbooks are how pentesters share repeatable testing approaches the
// same way nuclei templates share detection rules.
//
// VULNEXIS adaptation: builtins target the registered tool set, share format
// is JSON (no YAML dependency), and execution flows through the normal agent
// turn runner so scope enforcement and approval gates always apply.

import type { Finding } from './missions';

export interface PlaybookInput {
  name: string;
  required: boolean;
  default: string;
  prompt: string;
}

export interface PlaybookPhase {
  id: string;
  tools: string[];
  depends_on: string[];
  condition: string;
  manual: boolean;
  checklist: string[];
}

export interface Playbook {
  name: string;
  description: string;
  version: string;
  intensity: 'stealth' | 'safe' | 'normal' | 'aggressive';
  inputs: Record<string, PlaybookInput>;
  phases: PlaybookPhase[];
}

export class PlaybookError extends Error {}

export function parsePlaybook(raw: unknown): Playbook {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== 'object') throw new PlaybookError('Playbook must be a JSON object');
  if (typeof r.name !== 'string' || !r.name.trim()) throw new PlaybookError("Playbook: missing required 'name'");
  if (!Array.isArray(r.phases) || r.phases.length === 0) {
    throw new PlaybookError(`${r.name}: must declare at least one phase`);
  }
  // Refuse playbooks with bare credential keys (pentest-ai rule).
  for (const forbidden of ['password', 'token', 'secret']) {
    if (forbidden in r) throw new PlaybookError(`${r.name}: refusing playbook with bare '${forbidden}' key`);
  }
  const phases: PlaybookPhase[] = r.phases.map((p, i) => {
    const ph = p as Record<string, unknown>;
    if (typeof ph.id !== 'string' || !ph.id.trim()) throw new PlaybookError(`${r.name}: phase ${i} missing 'id'`);
    return {
      id: String(ph.id),
      tools: Array.isArray(ph.tools) ? ph.tools.map(String) : [],
      depends_on: Array.isArray(ph.depends_on) ? ph.depends_on.map(String) : [],
      condition: typeof ph.condition === 'string' ? ph.condition : '',
      manual: Boolean(ph.manual),
      checklist: Array.isArray(ph.checklist) ? ph.checklist.map(String) : [],
    };
  });
  const intensity = (['stealth', 'safe', 'normal', 'aggressive'] as const).includes(r.intensity as never)
    ? (r.intensity as Playbook['intensity'])
    : 'normal';
  const inputs: Record<string, PlaybookInput> = {};
  if (r.inputs && typeof r.inputs === 'object') {
    for (const [name, v] of Object.entries(r.inputs as Record<string, unknown>)) {
      const spec = (typeof v === 'object' && v !== null ? v : { default: String(v) }) as Record<string, unknown>;
      inputs[name] = {
        name,
        required: Boolean(spec.required),
        default: typeof spec.default === 'string' ? spec.default : '',
        prompt: typeof spec.prompt === 'string' ? spec.prompt : '',
      };
    }
  }
  const pb: Playbook = {
    name: String(r.name),
    description: typeof r.description === 'string' ? r.description : '',
    version: typeof r.version === 'string' ? r.version : '0.1.0',
    intensity,
    inputs,
    phases,
  };
  validatePlaybook(pb);
  return pb;
}

export function validatePlaybook(pb: Playbook) {
  const seen = new Set<string>();
  for (const phase of pb.phases) {
    if (seen.has(phase.id)) throw new PlaybookError(`${pb.name}: duplicate phase id '${phase.id}'`);
    seen.add(phase.id);
  }
  for (const phase of pb.phases) {
    for (const dep of phase.depends_on) {
      if (!seen.has(dep)) throw new PlaybookError(`${pb.name}: phase '${phase.id}' depends on unknown phase '${dep}'`);
    }
  }
}

export function importPlaybook(text: string): Playbook {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PlaybookError('Playbook file is not valid JSON.');
  }
  return parsePlaybook(raw);
}

// ---------------------------------------------------------------------------
// Phase planner: honours depends_on + conditions, returns a plan with skip
// reasons so the UI can show what will run and why.
// ---------------------------------------------------------------------------

export interface PlannedPhase {
  phase: PlaybookPhase;
  willRun: boolean;
  reason: string;
}

/**
 * Simple condition grammar over the live findings (pentest-ai style):
 *   has_finding()                      — any finding exists
 *   has_finding(severity='high')       — a finding of that severity exists
 *   has_verified()                     — a verified finding exists
 */
function evalCondition(condition: string, findings: Finding[]): boolean {
  const m = condition.trim().match(/^has_(\w+)\s*(?:\((.*)\))?$/);
  if (!m) throw new Error(`unsupported condition: ${condition}`);
  const [, name, argsRaw] = m;
  const args = Object.fromEntries(
    (argsRaw ?? '')
      .split(',')
      .map((kv) => kv.split('=').map((s) => s.trim().replace(/^['"]|['"]$/g, '')))
      .filter((kv) => kv.length === 2)
  );
  switch (name) {
    case 'finding': {
      if (args.severity) return findings.some((f) => f.severity === args.severity);
      return findings.length > 0;
    }
    case 'verified':
      return findings.some((f) => f.status === 'verified');
    default:
      throw new Error(`unsupported condition: ${condition}`);
  }
}

export function planPhases(pb: Playbook, findings: Finding[]): PlannedPhase[] {
  const skipped = new Set<string>();
  const out: PlannedPhase[] = [];
  for (const phase of pb.phases) {
    let willRun = true;
    let reason = '';
    const missingDep = phase.depends_on.find((d) => skipped.has(d));
    if (missingDep) {
      willRun = false;
      reason = `dependency '${missingDep}' was skipped`;
    }
    if (willRun && phase.condition) {
      try {
        if (!evalCondition(phase.condition, findings)) {
          willRun = false;
          reason = `condition did not match: ${phase.condition}`;
        }
      } catch (e) {
        willRun = false;
        reason = `condition error: ${String(e)}`;
      }
    }
    if (!willRun) skipped.add(phase.id);
    out.push({ phase, willRun, reason });
  }
  return out;
}

/** Prompt sent to the agent for a phase run — the phase contract in one message. */
export function phasePrompt(pb: Playbook, phase: PlaybookPhase, inputs: Record<string, string>): string {
  const lines: string[] = [];
  lines.push(`[playbook ${pb.name} — phase "${phase.id}"]`);
  if (phase.tools.length) {
    lines.push(`Run these registered tools (one per response, adapt targets from results): ${phase.tools.join(', ')}.`);
  } else {
    lines.push('Execute this phase of the methodology with appropriate registered tools.');
  }
  for (const [k, v] of Object.entries(inputs)) {
    if (v.trim()) lines.push(`${k}: ${v}`);
  }
  if (phase.checklist.length) {
    lines.push('Checklist to cover in your final summary:');
    for (const c of phase.checklist) lines.push(`- ${c}`);
  }
  return lines.join('\n');
}

export function resolveInputs(pb: Playbook, provided: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(pb.inputs)) {
    const value = provided[name] ?? spec.default;
    if (!value && spec.required) throw new PlaybookError(`${pb.name}: required input '${name}' not provided`);
    out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Builtin playbooks, adapted from pentest-ai/playbooks/builtin to the tools
// registered in VULNEXIS.
// ---------------------------------------------------------------------------

export const BUILTINS: Playbook[] = [
  {
    name: 'external-recon',
    description:
      'Methodology-grade external recon: subdomain enum -> live-host fingerprint -> human wrap-up. Passive-first; respects mission intensity.',
    version: '1.0.0',
    intensity: 'normal',
    inputs: {
      target: {
        name: 'target',
        required: true,
        default: '',
        prompt: 'Root domain in scope (e.g. example.com)',
      },
    },
    phases: [
      {
        id: 'subdomain-enum',
        tools: ['subfinder', 'amass'],
        depends_on: [],
        condition: '',
        manual: false,
        checklist: ['Note any wildcard DNS behavior that would poison results'],
      },
      {
        id: 'live-hosts',
        tools: ['httpx', 'whatweb', 'wafw00f'],
        depends_on: ['subdomain-enum'],
        condition: '',
        manual: false,
        checklist: ['Map technologies per live host', 'Flag hosts behind a WAF — they change the exploit phase'],
      },
      {
        id: 'wrap-up',
        tools: [],
        depends_on: ['live-hosts'],
        condition: '',
        manual: true,
        checklist: [
          'Confirm every tested host is inside the mission scope',
          'Summarize the attack surface for the next session',
        ],
      },
    ],
  },
  {
    name: 'web-app-quick',
    description:
      'Fast web-app pass: fingerprint -> param mining -> targeted vuln scan -> human wrap-up. Ideal for one lab host.',
    version: '1.0.0',
    intensity: 'normal',
    inputs: {
      target: {
        name: 'target',
        required: true,
        default: '',
        prompt: 'Base URL in scope (e.g. http://10.0.0.5:8080)',
      },
    },
    phases: [
      {
        id: 'fingerprint',
        tools: ['httpx', 'whatweb', 'wafw00f'],
        depends_on: [],
        condition: '',
        manual: false,
        checklist: [],
      },
      {
        id: 'param-mining',
        tools: ['katana', 'waybackurls', 'paramspider', 'arjun'],
        depends_on: ['fingerprint'],
        condition: '',
        manual: false,
        checklist: ['Collect real parameter names — they feed the probe phase'],
      },
      {
        id: 'probe',
        tools: ['nuclei', 'dalfox'],
        depends_on: ['param-mining'],
        condition: 'has_finding()',
        manual: false,
        checklist: ['Only in-scope targets; nuclei/dalfox output stays CANDIDATE until an oracle verifies it'],
      },
      {
        id: 'wrap-up',
        tools: [],
        depends_on: ['probe'],
        condition: '',
        manual: true,
        checklist: [
          'Review only oracle-VERIFIED findings; candidates are not submittable',
          'Extract findings from this session into Mission Intel',
        ],
      },
    ],
  },
  {
    name: 'bug-bounty-web',
    description:
      'Full bug-bounty methodology: subdomain enum -> live-host fingerprint -> URL/param mining -> targeted probes -> verification -> human wrap-up. Runs at stealth intensity (rate-limited, jittered).',
    version: '1.0.0',
    intensity: 'stealth',
    inputs: {
      target: {
        name: 'target',
        required: true,
        default: '',
        prompt: 'Root domain or URL in the program scope (e.g. example.com)',
      },
    },
    phases: [
      {
        id: 'subdomain-enum',
        tools: ['subfinder', 'amass'],
        depends_on: [],
        condition: '',
        manual: false,
        checklist: ['Keep it passive-first; the program scope was imported and enforced per-request'],
      },
      {
        id: 'live-hosts',
        tools: ['httpx', 'whatweb', 'wafw00f'],
        depends_on: ['subdomain-enum'],
        condition: '',
        manual: false,
        checklist: ['Feed later phases a live, fingerprinted surface instead of raw DNS'],
      },
      {
        id: 'param-mining',
        tools: ['katana', 'gau', 'waybackurls', 'paramspider', 'arjun'],
        depends_on: ['live-hosts'],
        condition: '',
        manual: false,
        checklist: ['Historical URLs + hidden parameters give the probe phase real injection points'],
      },
      {
        id: 'probe',
        tools: ['nuclei', 'dalfox'],
        depends_on: ['param-mining'],
        condition: 'has_finding()',
        manual: false,
        checklist: ['Scope-filtered only; output is held as candidate until a native oracle re-proves it (prove-or-kill)'],
      },
      {
        id: 'wrap-up',
        tools: [],
        depends_on: ['probe'],
        condition: '',
        manual: true,
        checklist: [
          'Confirm every tested host is inside the program scope (no out-of-scope hits)',
          'Review only oracle-VERIFIED findings; candidates are not submittable',
          'Respect the program rate-limit rules (stealth intensity keeps N=2 replays)',
          'Generate submissions from verified findings in Mission Intel',
        ],
      },
    ],
  },
];
