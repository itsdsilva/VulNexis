// Machine oracle verification, adapted from pentest-ai's earned-verdict
// verifier: a finding is only "verified" when a machine-checkable oracle
// reproduces it. The LLM may propose the recipe, but it can never award the
// verdict — only the oracle output earns it. A miss is an abstain (stays
// candidate), never a disproof.

import { callLLM } from './llm';
import { isInScope, updateFinding, type Finding, type Mission, type OracleKind, type OracleRecipe, type Receipt } from './missions';

/** Replay count per mission intensity (pentest-ai G10: noise budget). */
export const REPLAY_N_BY_INTENSITY: Record<string, number> = {
  stealth: 2,
  safe: 2,
  normal: 3,
  aggressive: 5,
};

export interface VerifyDeps {
  connected: boolean;
  exec: (cmd: string) => Promise<string>;
  onStep?: (msg: string) => void;
}

export interface VerifyOutcome {
  findingId: string;
  verdict: 'verified' | 'candidate' | 'unverifiable';
  receipt: Receipt | null;
  log: string[];
}

// ---------------------------------------------------------------------------
// Safety: recipe commands are executed on the user's Kali box, so every one
// passes two fail-closed gates before running.
// ---------------------------------------------------------------------------

const DENYLIST: RegExp[] = [
  /\brm\s+-[a-z]*r/i,
  /\bmkfs/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{/,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bchmod\s+777\b/i,
  /\/dev\/(sd|nvme|hd)/i,
  /\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh)\b/i,
];

const MAX_CMD_LEN = 500;

function assertRecipeSafe(cmd: string, label: string) {
  if (!cmd || !cmd.trim()) throw new Error(`${label} command is empty`);
  if (cmd.length > MAX_CMD_LEN) throw new Error(`${label} command too long (${cmd.length} > ${MAX_CMD_LEN})`);
  for (const rx of DENYLIST) {
    if (rx.test(cmd)) throw new Error(`${label} command rejected by safety gate: matches ${rx}`);
  }
}

/** Every host the recipe could touch (URL hosts + bare IPv4s) — the scope lesson from capsule replay: gate them all. */
function commandHosts(cmd: string): string[] {
  const hosts = new Set<string>();
  for (const m of cmd.matchAll(/https?:\/\/([a-z0-9.-]+|\d{1,3}(?:\.\d{1,3}){3})/gi)) hosts.add(m[1].toLowerCase());
  for (const m of cmd.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) hosts.add(m[0]);
  return [...hosts];
}

function scopeGate(cmd: string, label: string, mission: Mission) {
  const hosts = commandHosts(cmd);
  const off = hosts.filter((h) => !isInScope(h, mission.scope));
  if (off.length) {
    throw new Error(`${label} command touches out-of-scope host(s): ${off.join(', ')}`);
  }
}

function checkRecipe(r: OracleRecipe, mission: Mission) {
  const kinds: OracleKind[] = ['unescaped_reflection', 'differential', 'idempotent_replay', 'server_state'];
  if (!kinds.includes(r.kind)) throw new Error(`Unknown oracle kind: ${r.kind}`);
  assertRecipeSafe(r.attack, 'attack');
  scopeGate(r.attack, 'attack', mission);
  if (r.control) {
    assertRecipeSafe(r.control, 'control');
    scopeGate(r.control, 'control', mission);
  }
  if (r.kind === 'differential' && !r.control) throw new Error('Differential oracle requires a control command');
  if (r.kind === 'server_state' && !r.control) throw new Error('Server-state oracle requires a check command (store it in "control")');
}

// ---------------------------------------------------------------------------
// Recipe generation: one LLM call proposes the recipe; MARKER is the canary
// placeholder the verifier swaps for a fresh random token at run time.
// ---------------------------------------------------------------------------

async function generateRecipe(mission: Mission, finding: Finding): Promise<OracleRecipe> {
  const res = await callLLM([
    {
      role: 'system',
      content:
        'You build machine-verifiable proof recipes for security findings. Reply ONLY with a single JSON object (no markdown, no fences): {"kind":"unescaped_reflection"|"differential"|"idempotent_replay"|"server_state","attack":"<single shell command>","control":"<optional single shell command>","marker":"<optional fixed canary>","note":"<what the oracle proves and what it does NOT>"}.\n' +
        'Rules:\n' +
        '- All commands run on the user\'s Kali box. Use standard tools (curl, curl -i, nmap -p, dig, httpx). ONE command each, no chaining with && beyond one pipe.\n' +
        '- In the attack command, write the literal placeholder MARKER wherever the canary/unique token goes. For server_state, "attack" is the state-changing request and "control" is the check command that prints the server state.\n' +
        '- For differential, "control" is the same request with a benign value where MARKER would go (write CONTROL_SAFE there); it must NOT demonstrate the weakness.\n' +
        '- unescaped_reflection: attack output must contain MARKER raw (not HTML-escaped/encoded). differential: attack contains MARKER and control does not. idempotent_replay: re-running attack N times gives the same result each time. server_state: check output changes after attack.\n' +
        '- Commands must not be destructive or noisy; they must target exactly: ' + finding.host + (finding.port ? ':' + finding.port : '') + '.\n' +
        '- Prove the narrowest thing the evidence supports (e.g. reflection proves unescaped reflection, NOT that JS executes).',
    },
    {
      role: 'user',
      content: `FINDING: ${finding.vuln}\nHOST: ${finding.host}${finding.port ? ':' + finding.port : ''}\nSEVERITY: ${finding.severity}\nEVIDENCE: ${finding.evidence || '(none)'}`,
    },
  ]);
  let parsed: any;
  try {
    parsed = JSON.parse(res.content.trim());
  } catch {
    const m = res.content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Recipe model did not return valid JSON.');
    parsed = JSON.parse(m[0]);
  }
  const recipe: OracleRecipe = {
    kind: String(parsed?.kind ?? '') as OracleKind,
    attack: String(parsed?.attack ?? ''),
    control: parsed?.control ? String(parsed.control) : undefined,
    marker: parsed?.marker ? String(parsed.marker) : undefined,
    description: parsed?.note ? String(parsed.note) : undefined,
  };
  checkRecipe(recipe, mission);
  return recipe;
}

// ---------------------------------------------------------------------------
// Oracle execution
// ---------------------------------------------------------------------------

interface OracleResult {
  passed: boolean;
  diff: string;
  lastResponse: string;
  successes: number;
  attempts: number;
}

function truncate(s: string, n = 2000) {
  return s.length > n ? s.slice(0, n) + '… (truncated)' : s;
}

interface AttackRun {
  outputs: string[];
  controlOutput?: string;
  rawAttack: string;
  rawControl?: string;
  marker: string;
  successTest: (out: string) => boolean;
}

async function runAttack(recipe: OracleRecipe, n: number, deps: VerifyDeps, log: string[]): Promise<AttackRun> {
  const marker = recipe.marker?.trim() || 'vx' + Math.random().toString(36).slice(2, 12);
  const rawAttack = recipe.attack.replace(/(VULNEXIS_)?MARKER/g, marker);
  const rawControl = recipe.control?.replace(/(VULNEXIS_)?MARKER/g, marker).replace(/(VULNEXIS_)?CONTROL_SAFE/g, 'safe' + marker.slice(2));

  const successTest = (out: string) =>
    recipe.marker || recipe.attack.includes('MARKER') ? out.includes(marker) : out.trim().length > 0;

  const outputs: string[] = [];
  for (let i = 0; i < n; i++) {
    deps.onStep?.(`attack run ${i + 1}/${n}: ${rawAttack}`);
    const out = (await deps.exec(rawAttack)).trim();
    outputs.push(out);
    log.push(`attack ${i + 1}/${n}: ${successTest(out) ? 'HIT' : 'miss'} — ${truncate(out, 200)}`);
  }
  let controlOutput: string | undefined;
  if (rawControl) {
    deps.onStep?.(`control run: ${rawControl}`);
    controlOutput = (await deps.exec(rawControl)).trim();
    log.push(`control: ${controlOutput.includes(marker) ? 'LEAKED (bad)' : 'clean'} — ${truncate(controlOutput, 200)}`);
  }
  return { outputs, controlOutput, rawAttack, rawControl, marker, successTest };
}

async function executeOracle(
  recipe: OracleRecipe,
  n: number,
  deps: VerifyDeps,
  log: string[]
): Promise<OracleResult> {
  switch (recipe.kind) {
    case 'unescaped_reflection':
    case 'idempotent_replay': {
      const run = await runAttack(recipe, n, deps, log);
      const hits = run.outputs.filter((o) => run.successTest(o)).length;
      let passed = hits === n;
      let diff = `${recipe.kind}: canary ${run.marker} present raw in ${hits}/${n} attack outputs`;
      if (recipe.kind === 'unescaped_reflection' && run.controlOutput !== undefined) {
        if (run.controlOutput.includes(run.marker)) {
          passed = false;
          diff += '; control also reflected the canary, so the oracle does not isolate the weakness';
        }
      }
      return {
        passed,
        diff: (recipe.description ? recipe.description + ' — ' : '') + diff,
        lastResponse: run.outputs[run.outputs.length - 1] ?? '',
        successes: hits,
        attempts: n,
      };
    }
    case 'differential': {
      const run = await runAttack(recipe, n, deps, log);
      const hits = run.outputs.filter((o) => run.successTest(o)).length;
      const ctrl = run.controlOutput ?? '';
      const passed = hits === n && !ctrl.includes(run.marker);
      return {
        passed,
        diff: `differential: canary ${run.marker} in ${hits}/${n} attack outputs, ${ctrl.includes(run.marker) ? 'present (bad)' : 'absent'} in control — attacker-only access proven`,
        lastResponse: run.outputs[run.outputs.length - 1] ?? '',
        successes: passed ? n : hits,
        attempts: n,
      };
    }
    case 'server_state': {
      const check = recipe.control!;
      deps.onStep?.(`baseline check: ${check}`);
      const before = (await deps.exec(check)).trim();
      log.push(`check before: ${truncate(before, 200)}`);
      const run = await runAttack({ ...recipe, control: undefined }, 1, deps, log);
      deps.onStep?.(`post-attack check: ${check}`);
      const after = (await deps.exec(check)).trim();
      log.push(`check after: ${truncate(after, 200)}`);
      const passed = before !== after;
      return {
        passed,
        diff: `server_state: check output ${passed ? 'CHANGED' : 'unchanged'} after attack with canary ${run.marker}`,
        lastResponse: after,
        successes: passed ? 1 : 0,
        attempts: 1,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function verifyFinding(mission: Mission, finding: Finding, deps: VerifyDeps): Promise<VerifyOutcome> {
  const log: string[] = [];
  if (!deps.connected) throw new Error('Kali is not connected. Open Settings → Kali SSH and connect first.');

  if (!isInScope(finding.host, mission.scope)) {
    throw new Error(`Refused: ${finding.host} is not in the mission scope.`);
  }

  let recipe = finding.recipe;
  try {
    if (!recipe) {
      deps.onStep?.('generating verification recipe…');
      recipe = await generateRecipe(mission, finding);
      updateFinding(finding.id, { recipe });
      log.push(`recipe: ${recipe.kind} — ${truncate(recipe.attack, 200)}`);
    } else {
      checkRecipe(recipe, mission); // re-gate persisted recipes (scope may have changed)
    }
  } catch (e) {
    updateFinding(finding.id, { status: 'unverifiable' });
    log.push(`unverifiable: ${String(e)}`);
    return { findingId: finding.id, verdict: 'unverifiable', receipt: null, log };
  }

  const n = REPLAY_N_BY_INTENSITY[mission.intensity ?? 'normal'] ?? 3;
  log.push(`intensity ${mission.intensity ?? 'normal'} → replay N=${n}`);

  try {
    const result = await executeOracle(recipe, n, deps, log);
    const receipt: Receipt = {
      schemaVersion: 1,
      findingId: finding.id,
      verdict: result.passed ? 'verified' : 'candidate',
      oracleKind: recipe.kind,
      evidence: { request: recipe.attack, response: truncate(result.lastResponse), diff: result.diff },
      replay: { successes: result.successes, attempts: result.attempts },
      createdAt: new Date().toISOString(),
    };
    // A miss is an abstain, not a disproof: stays candidate.
    updateFinding(finding.id, {
      status: result.passed ? 'verified' : 'candidate',
      receipt,
    });
    log.push(`verdict: ${receipt.verdict} (${result.successes}/${result.attempts})`);
    return {
      findingId: finding.id,
      verdict: result.passed ? 'verified' : 'candidate',
      receipt,
      log,
    };
  } catch (e) {
    log.push(`oracle error: ${String(e)}`);
    // Execution failure is also an abstain — never refutes.
    return { findingId: finding.id, verdict: 'candidate', receipt: null, log };
  }
}
