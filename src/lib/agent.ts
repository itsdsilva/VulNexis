// VulNexis agent engine: one turn runner used by chat UI and scheduled tasks
import { callLLM } from './llm';
import { callLLMStream } from './stream';
import { sshExec, sshDetectTools } from './ssh';
import { type GoalState, type PermissionMode, type Session, type SessionGoal, type StoredMsg } from './store';
import type { Mission } from './missions';
import {
  TOOLS,
  ToolError,
  buildToolCommand,
  cacheGet,
  cacheSet,
  hostnameOf,
  toolTargetInScope,
} from './tools';
import { browserClick, browserLaunch, browserNavigate, browserSnapshot, browserType } from './browser';

const AGENT_EXTRAS: Record<string, string> = {
  pentest: 'Follow a balanced pentest methodology: recon, enumeration, then targeted testing.',
  recon: 'Focus on mapping the attack surface: subdomains, open ports, technologies, endpoints. Avoid state-changing actions.',
  web: 'Focus on the HTTP surface: endpoints, parameters, auth flows, business logic. Guide manual testing.',
  privesc: 'Focus on privilege escalation paths once initial access is achieved. Stay in scope.',
  expl: 'Focus on validating identified vulnerabilities safely. No destructive payloads.',
  replan: 'Re-evaluate the current plan based on all findings so far and propose next steps.',
};

const MAX_STEPS = 12;

function now() {
  return new Date().toISOString();
}

function append(s: Session, m: Omit<StoredMsg, 'ts'>): Session {
  return { ...s, messages: [...s.messages, { ...m, ts: now() }], updatedAt: now() };
}

/** Append an empty assistant message that will be filled in as tokens stream. */
function appendLive(s: Session): { session: Session; idx: number } {
  const next = append(s, { role: 'assistant', text: '' });
  return { session: next, idx: next.messages.length - 1 };
}

function patchMsg(s: Session, idx: number, text: string): Session {
  return {
    ...s,
    messages: s.messages.map((m, i) => (i === idx ? { ...m, text } : m)),
    updatedAt: now(),
  };
}

function removeMsg(s: Session, idx: number): Session {
  return { ...s, messages: s.messages.filter((_, i) => i !== idx), updatedAt: now() };
}

function stripFences(t: string): string {
  let x = t.trim();
  if (x.startsWith('```')) {
    x = x.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
  }
  return x;
}

function toolCatalog(): string {
  return TOOLS.map(
    (t) =>
      `- ${t.name} [${t.risk} risk, ${t.targetKind}] ${t.description} params: ${
        t.params.map((p) => p.name).join(', ') || 'none'
      }`
  ).join('\n');
}

function systemPrompt(mission: Mission | null, tools: string[], agent: string): string {
  if (!mission) {
    return `You are VulNexis, a concise AI assistant with deep cybersecurity expertise (bug bounty, penetration testing, Kali Linux tooling).
The user is chatting outside of any mission, so you cannot run commands right now. Answer questions, explain concepts, help plan assessments, and suggest what to test — if the user wants you to actually run something, tell them to create a Mission and connect their Kali VM.
Be helpful and concise.`;
  }
  const sc = mission.scope;
  const INTENSITY_GUIDE: Record<NonNullable<Mission['intensity']>, string> = {
    stealth: 'Passive-first. Rate-limit every tool (e.g. --rate, -T1, --delay). No scanning bursts, no parallel hits. One request at a time.',
    safe: 'Read-only probing. Prefer single requests and small scans; avoid anything state-changing beyond trivial interactions.',
    normal: 'Balanced methodology. Standard scan speeds; still no destructive actions.',
    aggressive: 'Broader, faster scanning allowed on in-scope targets. Still no destructive actions, no DoS.',
  };
  const intensity = mission.intensity ?? 'normal';
  const bb = mission.kind === 'bugbounty';
  return `You are VulNexis, an expert Web Application Penetration Testing (WAPT) agent with a built-in browser. You can drive the browser to map authenticated apps, fill forms, click flows, capture requests/responses, and identify vulnerabilities. You also have Kali SSH tools available.

MISSION SCOPE (STRICT - never target anything outside this):
- Domains: ${sc.domains.length ? sc.domains.join(', ') : 'none'}
- IPs: ${sc.ips.length ? sc.ips.join(', ') : 'none'}
- Wildcards: ${sc.wildcards.length ? sc.wildcards.join(', ') : 'none'}
- OUT OF SCOPE (never touch): ${sc.outOfScope.length ? sc.outOfScope.join(', ') : 'none'}

MISSION INTENSITY (noise budget — ${intensity}): ${INTENSITY_GUIDE[intensity]}

${bb ? 'BUG BOUNTY MODE: This is a public/private bug bounty program. Hunt for report-worthy, impact-focused vulnerabilities. For every finding, state the severity, concrete impact, and minimal reproduction steps suitable for a HackerOne/Bugcrowd report. Prioritize: IDOR, access control, business logic, XSS, SSRF, injection, auth flaws. Avoid noise — only surface findings worth submitting.\n' : ''}Available Kali tools: ${tools.join(', ') || 'standard Kali tools'}.

REGISTERED TOOLS (prefer these — commands are built and validated automatically):
${toolCatalog()}

AGENT FOCUS: ${AGENT_EXTRAS[agent] ?? AGENT_EXTRAS.pentest}

RULES:
1. Authorized testing only. No destructive actions, no DoS, no credential brute-forcing, no exploit payloads for live targets.
2. For WAPT: start with browser_launch + browser_navigate to the in-scope URL, take browser_snapshot to map forms/links/inputs, discover auth flows. Test methodically for: IDOR, broken access control, auth/session flaws, XSS, CSRF, SQLi, SSRF, file upload, business logic. Document findings with evidence.
3. Prefer safe testing. One action per response.
4. Targets must be inside the mission scope.
5. If a command fails, read the error and adapt.
6. Be concise and actionable.

Respond ONLY with a single JSON object (no markdown, no code fences):
- {"action":"run_tool","tool":"<tool name>","target":"<in-scope target>","params":{...},"reason":"<why>"}
- {"action":"suggest_command","command":"<exact shell command>","reason":"<why>","risk":"low|medium|high"}
- {"action":"respond","message":"<text>"}
`;
}

function toChatHistory(messages: StoredMsg[]): { role: string; content: string }[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'user', content: `TOOL OUTPUT:\n${m.text}` };
    if (m.role === 'error') return { role: 'user', content: `ERROR:\n${m.text}` };
    return { role: m.role, content: m.text };
  });
}

async function getToolNames(): Promise<string[]> {
  try {
    return (await sshDetectTools()).filter((t) => t.available).map((t) => t.name);
  } catch {
    return [];
  }
}

function modelOverride(session: Session) {
  return session.model
    ? { model: session.model, provider: session.provider, baseUrl: session.baseUrl }
    : undefined;
}

export interface RunTurnOpts {
  connected: boolean;
  permission: PermissionMode;
  budget: number; // max total tokens for this mission, 0 = unlimited
  usageTotal: number;
  onUpdate: (s: Session) => void;
  onUsage: (u: { prompt: number; completion: number; total: number; calls: number }) => void;
  onFork?: (s: Session) => void; // reserved: lets callers snapshot a session mid-turn
}

export async function runTurn(
  mission: Mission | null,
  session0: Session,
  userText: string,
  opts: RunTurnOpts
): Promise<Session> {
  let session = append(session0, { role: 'user', text: userText });
  opts.onUpdate(session);

  // Detect "run" / "approve" replies against the last suggested command.
  // The pending command is the most recent "$ ..." assistant message that has
  // not yet been followed by a tool/error result.
  let pendingCmd: string | undefined;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === 'tool' || m.role === 'error') break; // already executed
    if (m.role === 'assistant') {
      const match = m.text.match(/^\$ (.+)$/m);
      if (match) {
        pendingCmd = match[1];
        break;
      }
    }
  }
  const isApproval = /^(run|approve|approved|yes|go|go ahead|execute|do it)\b/i.test(userText.trim());

  if (mission && isApproval && pendingCmd) {
    if (!opts.connected) {
      session = append(session, { role: 'error', text: 'Kali is not connected. Open Settings → Kali SSH and connect first.' });
      opts.onUpdate(session);
      return session;
    }
    session = append(session, { role: 'tool', text: `Running: ${pendingCmd}` });
    opts.onUpdate(session);
    try {
      const out = await sshExec(pendingCmd);
      session = append(session, { role: 'tool', text: out.trim() || '(no output)' });
      opts.onUpdate(session);
    } catch (e) {
      session = append(session, { role: 'error', text: String(e) });
      opts.onUpdate(session);
    }
  }

  // Mission-less chats behave like a normal AI app (ChatGPT-style): one
  // straight LLM call, no tool protocol, no Kali needed.
  if (!mission) {
    const history = toChatHistory(session.messages).slice(-24);
    const msgs = [
      { role: 'system', content: systemPrompt(null, [], session.agent) },
      ...history,
    ];
    let liveIdx = -1;
    try {
      const live = appendLive(session);
      session = live.session;
      liveIdx = live.idx;
      opts.onUpdate(session);

      const res = await callLLMStream(msgs, modelOverride(session), (full) => {
        session = patchMsg(session, liveIdx, full);
        opts.onUpdate(session);
      });
      const usage = {
        prompt: res.usage.prompt_tokens,
        completion: res.usage.completion_tokens,
        total: res.usage.total_tokens,
        calls: 1,
      };
      opts.onUsage(usage);
      session = patchMsg(session, liveIdx, res.content);
      opts.onUpdate(session);
    } catch (e) {
      if (liveIdx >= 0) session = removeMsg(session, liveIdx);
      session = append(session, { role: 'error', text: String(e) });
      opts.onUpdate(session);
    }
    return session;
  }

  let tools = opts.connected ? await getToolNames() : [];
  let used = opts.usageTotal;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (opts.budget > 0 && used >= opts.budget) {
      session = append(session, {
        role: 'error',
        text: `Token budget reached (${used.toLocaleString()}/${opts.budget.toLocaleString()}). Stopping auto-run.`,
      });
      opts.onUpdate(session);
      break;
    }

    const history = toChatHistory(session.messages).slice(-16);
    const msgs = [
      { role: 'system', content: systemPrompt(mission, tools, session.agent) },
      ...history,
    ];
    let res;
    let liveIdx = -1;
    try {
      const live = appendLive(session);
      session = live.session;
      liveIdx = live.idx;
      opts.onUpdate(session);
      res = await callLLMStream(msgs, modelOverride(session), (full) => {
        session = patchMsg(session, liveIdx, full);
        opts.onUpdate(session);
      });
      session = removeMsg(session, liveIdx);
      liveIdx = -1;
      opts.onUpdate(session);
    } catch (e) {
      if (liveIdx >= 0) session = removeMsg(session, liveIdx);
      session = append(session, { role: 'error', text: String(e) });
      opts.onUpdate(session);
      break;
    }
    const usage = {
      prompt: res.usage.prompt_tokens,
      completion: res.usage.completion_tokens,
      total: res.usage.total_tokens,
      calls: 1,
    };
    opts.onUsage(usage);
    used += usage.total;

    let parsed: any = null;
    try {
      parsed = JSON.parse(stripFences(res.content));
    } catch {
      parsed = null;
    }

    if (parsed?.action === 'suggest_command' && typeof parsed.command === 'string') {
      const risk: string = parsed.risk ?? 'low';
      session = append(session, {
        role: 'assistant',
        text: `$ ${parsed.command}\n${parsed.reason ? parsed.reason + '\n' : ''}[risk: ${risk}]`,
      });
      opts.onUpdate(session);

      const allowed =
        opts.connected && (opts.permission === 'full' || (opts.permission === 'auto-low' && risk === 'low'));
      if (!allowed) {
        session = append(session, {
          role: 'assistant',
          text: opts.connected
            ? 'Awaiting your approval. Reply "run" to execute it, or give different instructions.'
            : 'Kali is not connected. Connect in Settings to run commands.',
        });
        opts.onUpdate(session);
        break;
      }

      try {
        const out = await sshExec(parsed.command);
        session = append(session, { role: 'tool', text: out.trim() || '(no output)' });
        opts.onUpdate(session);
      } catch (e) {
        session = append(session, { role: 'error', text: String(e) });
        opts.onUpdate(session);
        continue;
      }
      continue;
    }

    // Structured tool invocation: registry builds the command from params
    if (parsed?.action === 'run_tool' && typeof parsed.tool === 'string') {
      try {
        const target = String(parsed.target ?? '');
        const { spec, command } = buildToolCommand(parsed.tool, target, parsed.params);
        if (!toolTargetInScope(target, mission.scope)) {
          session = append(session, {
            role: 'error',
            text: `Refused: ${hostnameOf(target) || target} is not in the mission scope.`,
          });
          opts.onUpdate(session);
          break;
        }
        const risk: string = spec.risk;
        session = append(session, {
          role: 'assistant',
          text: `$ ${command}\n${parsed.reason ? parsed.reason + '\n' : ''}[tool: ${spec.name}, risk: ${risk}]`,
        });
        opts.onUpdate(session);

        const allowed =
          opts.connected && (opts.permission === 'full' || (opts.permission === 'auto-low' && risk === 'low'));
        if (!allowed) {
          session = append(session, {
            role: 'assistant',
            text: opts.connected
              ? 'Awaiting your approval. Reply "run" to execute it, or give different instructions.'
              : 'Kali is not connected. Connect in Settings to run commands.',
          });
          opts.onUpdate(session);
          break;
        }

        // Handle built-in browser tools
        if (command.startsWith('browser:')) {
          try {
            const parts = command.split(/\s+/);
            const op = parts[0];
            if (op === 'browser:launch') {
              const out = await browserLaunch(parts[1] !== 'false');
              session = append(session, { role: 'tool', text: `Browser launched: ${out}` });
              opts.onUpdate(session);
            } else if (op === 'browser:navigate') {
              const url = parts.slice(1).join(' ');
              const out = await browserNavigate(url);
              session = append(session, { role: 'tool', text: `Navigated: ${out}` });
              opts.onUpdate(session);
            } else if (op === 'browser:snapshot') {
              const snap = await browserSnapshot();
              const summary = `URL: ${snap.url}\nTitle: ${snap.title}\nForms: ${snap.forms.length}\nLinks: ${snap.links.length}\nInputs: ${snap.inputs.length}\nHTML: ${snap.html.slice(0, 800)}...`;
              session = append(session, { role: 'tool', text: summary });
              opts.onUpdate(session);
            } else if (op === 'browser:click') {
              const sel = parts.slice(1).join(' ');
              await browserClick({ selector: sel });
              session = append(session, { role: 'tool', text: `Clicked: ${sel}` });
              opts.onUpdate(session);
            } else if (op === 'browser:type') {
              const sel = parts[1];
              const val = parts.slice(2).join(' ');
              await browserType(sel, val);
              session = append(session, { role: 'tool', text: `Typed into ${sel}` });
              opts.onUpdate(session);
            } else {
              session = append(session, { role: 'error', text: `Unknown browser op: ${op}` });
              opts.onUpdate(session);
            }
          } catch (e) {
            session = append(session, { role: 'error', text: String(e) });
            opts.onUpdate(session);
          }
          continue;
        }

        const cached = cacheGet(command);
        let out: string;
        if (cached !== undefined) {
          out = cached;
          session = append(session, { role: 'assistant', text: '(cached, 30 min TTL)' });
          opts.onUpdate(session);
        } else {
          out = await sshExec(command);
          out = out.trim() || '(no output)';
          cacheSet(command, out);
        }
        const capped = out.length > 4000 ? out.slice(0, 4000) + '\n… (truncated)' : out;
        session = append(session, { role: 'tool', text: capped });
        opts.onUpdate(session);
        continue;
      } catch (e) {
        const msg = e instanceof ToolError ? String(e) : `run_tool failed: ${String(e)}`;
        session = append(session, { role: 'error', text: msg });
        opts.onUpdate(session);
        break;
      }
    }

    session = append(session, { role: 'assistant', text: parsed?.message ?? res.content });
    opts.onUpdate(session);
    break;
  }

  return session;
}

// Scheduled tasks: one full autonomous pass with safe defaults
export async function runScheduledAgent(mission: Mission, session: Session): Promise<Session> {
  const first = session.messages.find((m) => m.role === 'user')?.text ?? 'Begin reconnaissance.';
  return await runTurn(mission, session, first, {
    connected: true,
    permission: 'auto-low',
    budget: 100000,
    usageTotal: 0,
    onUpdate: () => {},
    onUsage: () => {},
  });
}

// ---------------------------------------------------------------------------
// Session goals: turn a prompt into a finish line the agent keeps working
// toward. After every turn an independent auditor judges the latest reply
// against the objective: keep going, done, or stuck. Mirrors ShipChamber.
// ---------------------------------------------------------------------------

export interface GoalLoopOpts {
  connected: boolean;
  permission: PermissionMode;
  budget: number; // mission-level token budget, 0 = unlimited
  usageTotal: number; // tokens already spent in this mission
  shouldStop: () => boolean; // explicit pause/stop always wins over the loop
  onUpdate: (s: Session) => void;
  onUsage: (u: { prompt: number; completion: number; total: number; calls: number }) => void;
}

function withGoal(s: Session, goal: SessionGoal): Session {
  return { ...s, goal, updatedAt: now() };
}

const GOAL_TERMINAL: GoalState[] = ['complete', 'blocked', 'budget'];

export async function runGoalLoop(
  mission: Mission | null,
  session0: Session,
  opts: GoalLoopOpts
): Promise<Session> {
  let session = session0;
  const startGoal = session.goal;
  if (!startGoal || GOAL_TERMINAL.includes(startGoal.state)) return session;

  session = withGoal(session, { ...startGoal, state: 'running' });
  opts.onUpdate(session);

  let spent = 0; // tokens spent by this goal loop
  const usageAcc = (u: { prompt: number; completion: number; total: number; calls: number }) => {
    spent += u.total;
    opts.onUsage(u);
  };

  const base = {
    connected: opts.connected,
    permission: opts.permission,
    onUpdate: opts.onUpdate,
  };

  // First turn: the objective itself, if the session hasn't started yet
  if (session.messages.length === 0) {
    session = await runTurn(mission, session, session.goal!.criteria, {
      ...base,
      budget: session.goal!.budget > 0 ? session.goal!.budget : opts.budget,
      usageTotal: opts.usageTotal,
      onUsage: usageAcc,
    });
  }

  for (;;) {
    if (opts.shouldStop()) return session; // paused — resume re-arms the loop
    let goal = session.goal!;
    if (goal.turns >= goal.maxTurns) {
      session = withGoal(session, { ...goal, state: 'blocked', note: `Turn cap reached (${goal.maxTurns}).` });
      opts.onUpdate(session);
      break;
    }
    if (goal.budget > 0 && spent >= goal.budget) {
      session = withGoal(session, {
        ...goal,
        state: 'budget',
        note: `Goal token budget reached (${spent.toLocaleString()}/${goal.budget.toLocaleString()}).`,
      });
      opts.onUpdate(session);
      break;
    }

    const audit = await auditGoal(mission, session, goal);
    goal = session.goal!;
    if (audit.verdict === 'done') {
      session = withGoal(session, { ...goal, state: 'complete', note: audit.note, blockedStreak: 0 });
      opts.onUpdate(session);
      break;
    }
    if (audit.verdict === 'stuck') {
      const streak = goal.blockedStreak + 1;
      session = withGoal(session, { ...goal, blockedStreak: streak, note: audit.note });
      opts.onUpdate(session);
      if (streak >= 3) {
        session = withGoal(session, { ...session.goal!, state: 'blocked', note: `Blocked: ${audit.note}` });
        opts.onUpdate(session);
        break;
      }
    } else {
      session = withGoal(session, { ...goal, blockedStreak: 0, note: audit.note, state: 'running' });
      opts.onUpdate(session);
    }

    // Continuation nudge
    goal = session.goal!;
    session = withGoal(session, { ...goal, turns: goal.turns + 1 });
    opts.onUpdate(session);
    session = await runTurn(
      mission,
      session,
      `[goal loop] Keep working toward: ${goal.criteria}\nAuditor progress note: ${audit.note}\nIf the goal is now fully met, reply with a final summary starting with "GOAL COMPLETE".`,
      {
        ...base,
        budget: goal.budget > 0 ? opts.usageTotal + goal.budget : opts.budget,
        usageTotal: opts.usageTotal + spent,
        onUsage: usageAcc,
      }
    );
  }

  return session;
}

type GoalVerdict = 'keep_going' | 'done' | 'stuck';

async function auditGoal(
  mission: Mission | null,
  session: Session,
  goal: SessionGoal
): Promise<{ verdict: GoalVerdict; note: string }> {
  const lastAssistant = [...session.messages].reverse().find((m) => m.role === 'assistant');
  const recentTool = session.messages
    .filter((m) => m.role === 'tool')
    .slice(-2)
    .map((m) => m.text.slice(0, 600))
    .join('\n---\n');
  const scopeHint = mission
    ? `MISSION SCOPE: ${[...mission.scope.domains, ...mission.scope.ips, ...mission.scope.wildcards].join(', ') || '(none)'}`
    : 'NO MISSION (plain chat session).';
  try {
    const res = await callLLM(
      [
        {
          role: 'system',
          content:
            'You are a strict progress auditor. Reply ONLY with a single JSON object, no markdown: {"verdict":"keep_going"|"done"|"stuck","note":"<one-line progress note>"}.',
        },
        {
          role: 'user',
          content: `${scopeHint}\n\nOBJECTIVE: ${goal.criteria}\n\nLATEST AGENT REPLY:\n${(lastAssistant?.text ?? '(none)').slice(0, 1500)}\n\nRECENT TOOL OUTPUT:\n${recentTool || '(none)'}\n\nRules: "done" only if the objective is verifiably achieved by the latest reply. "stuck" only if the agent is genuinely blocked and needs the user. Otherwise "keep_going".`,
        },
      ],
      modelOverride(session)
    );
    const parsed = JSON.parse(stripFences(res.content));
    const verdict: GoalVerdict = ['keep_going', 'done', 'stuck'].includes(parsed?.verdict)
      ? parsed.verdict
      : 'keep_going';
    return { verdict, note: String(parsed?.note ?? '') };
  } catch (e) {
    return { verdict: 'keep_going', note: `Auditor unavailable, continuing (${String(e)})` };
  }
}
