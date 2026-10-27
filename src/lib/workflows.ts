// VulNexis workflows — ported from HexStrike AI's bug-bounty manager:
// predefined multi-step chains of registered tools, executed in order with
// scope enforcement and a final LLM analysis of the combined results.

import { sshExec } from './ssh';
import { buildToolCommand, cacheGet, cacheSet, hostnameOf, toolTargetInScope } from './tools';
import { type Session, type StoredMsg } from './store';
import { callLLM } from './llm';
import { type Mission } from './missions';

export interface WorkflowStep {
  name: string;
  tool: string;
  params?: Record<string, string>;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
}

export const WORKFLOWS: Workflow[] = [
  {
    id: 'webapp-audit',
    name: 'Web App Audit',
    description:
      'Authenticated-capable WAPT: launch browser, map surface, discover forms/params, crawl, test with nuclei/nikto and analyze for vulns.',
    steps: [
      { name: 'Launch Browser', tool: 'browser_launch', params: { headless: 'true' } },
      { name: 'Navigate', tool: 'browser_navigate' },
      { name: 'Snapshot', tool: 'browser_snapshot' },
      { name: 'Technologies', tool: 'whatweb' },
      { name: 'WAF', tool: 'wafw00f' },
      { name: 'Directories', tool: 'gobuster' },
      { name: 'Crawl', tool: 'katana' },
      { name: 'Params', tool: 'arjun' },
      { name: 'Nuclei', tool: 'nuclei', params: { severity: 'high,critical,medium' } },
      { name: 'Nikto', tool: 'nikto' },
    ],
  },
  {
    id: 'recon',
    name: 'Recon Sweep',
    description:
      'Passive subdomain discovery, live-host probing, tech fingerprinting, top-port scan and WAF detection.',
    steps: [
      { name: 'Subdomains', tool: 'subfinder' },
      { name: 'Live hosts', tool: 'httpx' },
      { name: 'Technologies', tool: 'whatweb' },
      { name: 'Top ports', tool: 'nmap', params: { ports: '21,22,25,80,110,143,443,445,3306,3389,8080,8443' } },
      { name: 'WAF', tool: 'wafw00f' },
    ],
  },
  {
    id: 'vulnhunt',
    name: 'Vulnerability Hunt',
    description: 'Live-host probing followed by template-based vulnerability scanning and server checks.',
    steps: [
      { name: 'Live hosts', tool: 'httpx' },
      { name: 'Nuclei', tool: 'nuclei', params: { severity: 'high,critical' } },
      { name: 'Nikto', tool: 'nikto' },
    ],
  },
  {
    id: 'webmap',
    name: 'Web Mapping',
    description: 'Content discovery, crawling, hidden parameters and known URL archives.',
    steps: [
      { name: 'Directories', tool: 'gobuster' },
      { name: 'Crawl JS', tool: 'katana' },
      { name: 'Hidden params', tool: 'arjun' },
      { name: 'Archive URLs', tool: 'gau' },
    ],
  },
  {
    id: 'osint',
    name: 'OSINT Pass',
    description: 'Public-source intelligence: emails, subdomains, archived URLs.',
    steps: [
      { name: 'Harvest', tool: 'theharvester' },
      { name: 'Subdomains', tool: 'subfinder' },
      { name: 'Archive URLs', tool: 'gau' },
    ],
  },
];

export function getWorkflow(id: string): Workflow | undefined {
  return WORKFLOWS.find((w) => w.id === id);
}

/** First in-scope target of the mission: prefer a domain, then an IP. */
export function resolvePrimaryTarget(mission: Mission): string | null {
  const candidate = mission.scope.domains[0] ?? mission.scope.ips[0] ?? mission.scope.wildcards[0];
  if (!candidate) return null;
  if (!toolTargetInScope(candidate, mission.scope)) return null;
  return candidate;
}

function now() {
  return new Date().toISOString();
}

function append(session: Session, m: Omit<StoredMsg, 'ts'>): Session {
  return { ...session, messages: [...session.messages, { ...m, ts: now() }], updatedAt: now() };
}

const OUTPUT_CAP = 4000; // per-step cap so the session/LLM stays usable

/**
 * Execute a workflow's steps in order against the mission's primary target.
 * Mirrors HexStrike: scope gate per step, 30-min result cache, capped output.
 * Optionally asks the LLM for an analysis of combined results (best effort).
 */
export async function runWorkflow(
  mission: Mission,
  session0: Session,
  workflow: Workflow,
  opts: { connected: boolean; onUpdate: (s: Session) => void; withAnalysis?: boolean }
): Promise<Session> {
  let session = append(session0, {
    role: 'user',
    text: `Run workflow "${workflow.name}" on the mission's primary target.`,
  });
  opts.onUpdate(session);

  if (!opts.connected) {
    session = append(session, { role: 'error', text: 'Kali is not connected. Connect via Settings first.' });
    opts.onUpdate(session);
    return session;
  }

  const target = resolvePrimaryTarget(mission);
  if (!target) {
    session = append(session, {
      role: 'error',
      text: 'No in-scope primary target found in this mission. Add a domain or IP to the scope.',
    });
    opts.onUpdate(session);
    return session;
  }

  const outputs: string[] = [];

  for (const step of workflow.steps) {
    session = append(session, { role: 'assistant', text: `▶ ${step.name} — ${step.tool} on ${target}` });
    opts.onUpdate(session);

    try {
      const { spec, command } = buildToolCommand(step.tool, target, step.params);
      // Browser tools don't need SSH scope check
      if (command.startsWith('browser:')) {
        try {
          const parts = command.split(/\s+/);
          const op = parts[0];
          const { browserClick, browserLaunch, browserNavigate, browserSnapshot, browserType } = await import('./browser');
          if (op === 'browser:launch') {
            await browserLaunch(parts[1] !== 'false');
            session = append(session, { role: 'tool', text: 'Browser launched' });
            opts.onUpdate(session);
            continue;
          } else if (op === 'browser:navigate') {
            const url = target.startsWith('http') ? target : `https://${target}`;
            await browserNavigate(url);
            session = append(session, { role: 'tool', text: `Navigated to ${url}` });
            opts.onUpdate(session);
            continue;
          } else if (op === 'browser:snapshot') {
            const snap = await browserSnapshot();
            const summary = `URL: ${snap.url}\nTitle: ${snap.title}\nForms: ${snap.forms.length}\nLinks: ${snap.links.length}\nInputs: ${snap.inputs.length}`;
            session = append(session, { role: 'tool', text: summary });
            opts.onUpdate(session);
            outputs.push(`## ${step.name} (browser)\n${summary}`);
            continue;
          } else if (op === 'browser:click') {
            await browserClick({ selector: parts.slice(1).join(' ') });
            session = append(session, { role: 'tool', text: 'Clicked element' });
            opts.onUpdate(session);
            continue;
          } else if (op === 'browser:type') {
            await browserType(parts[1], parts.slice(2).join(' '));
            session = append(session, { role: 'tool', text: 'Typed into element' });
            opts.onUpdate(session);
            continue;
          }
        } catch (e) {
          session = append(session, { role: 'error', text: String(e) });
          opts.onUpdate(session);
          continue;
        }
      }
      if (!toolTargetInScope(target, mission.scope)) {
        session = append(session, { role: 'error', text: `Refused: ${hostnameOf(target)} is out of scope.` });
        opts.onUpdate(session);
        continue;
      }
      const cached = cacheGet(command);
      let out: string;
      if (cached !== undefined) {
        out = cached;
        session = append(session, { role: 'assistant', text: `(cached, 30 min TTL) ${command}` });
      } else {
        out = (await sshExec(command)).trim() || '(no output)';
        cacheSet(command, out);
      }
      const trimmed = out.length > OUTPUT_CAP ? out.slice(0, OUTPUT_CAP) + '\n… (truncated)' : out;
      session = append(session, { role: 'tool', text: trimmed });
      opts.onUpdate(session);
      outputs.push(`## ${step.name} (${spec.name}, risk ${spec.risk})\n${trimmed}`);
    } catch (e) {
      session = append(session, { role: 'error', text: String(e) });
      opts.onUpdate(session);
    }
  }

  if (opts.withAnalysis !== false && outputs.length > 0) {
    try {
      const summary = outputs.join('\n\n').slice(0, 6000);
      const res = await callLLM([
        {
          role: 'system',
          content:
            'You are VulNexis analyzing pentest workflow output. Summarize key findings, notable attack surface, vulnerabilities and recommended next steps for this mission. Be concise and concrete. The mission scope is strict: never suggest targeting anything out of scope.',
        },
        {
          role: 'user',
          content: `Mission: ${mission.name}\nTarget: ${target}\nWorkflow: ${workflow.name}\n\nOutput:\n${summary}`,
        },
      ]);
      session = append(session, { role: 'assistant', text: `Analysis\n\n${res.content}` });
      opts.onUpdate(session);
    } catch {
      // no API key or LLM failure — outputs above are still in the session
    }
  }

  return session;
}
