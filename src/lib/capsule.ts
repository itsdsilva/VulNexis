// Portable Proof Capsule, adapted from pentest-ai (engine/capsule.py):
// a self-contained, tamper-evident bundle for one verified finding — the
// finding, its verification recipe, and the receipt the oracle issued.
// Anyone can replay a capsule against the live target and watch the oracle
// re-confirm the verdict WITHOUT trusting this app: the replay is the trust
// mechanism, not a signature you have to believe.
//
// Integrity vs authenticity: integrity_sha256 is DRIFT-DETECTION, not an
// adversarial authenticity check. The digest proves the capsule was not
// edited after it was built; it does not attest who produced the proof.
// Authenticity comes from re-running the proof. We deliberately do not sign.

import type { Finding, Receipt } from './missions';
import { addFindings } from './missions';

export const CAPSULE_SCHEMA_VERSION = 1;
export const VULNEXIS_VERSION = '0.2.0';

export interface ProofCapsule {
  capsule_schema_version: number;
  app: string;
  app_version: string;
  created_at: string | null;
  finding: {
    id: string;
    title: string;
    target: string;
    severity: string;
    bug_class?: string;
    evidence: string;
    verification_recipe: unknown | null;
  };
  receipt: Receipt | null;
  integrity_sha256: string;
}

export class CapsuleError extends Error {}

/** Canonical JSON: sorted keys, no whitespace — deterministic for hashing. */
export function canonicalJson(value: unknown): string {
  const canonicalize = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(canonicalize);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined) continue;
      out[k] = canonicalize(val);
    }
    return out;
  };
  return JSON.stringify(canonicalize(value));
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256 over the canonical capsule with its own integrity field removed. */
export async function capsuleIntegrity(capsule: Omit<ProofCapsule, 'integrity_sha256'>): Promise<string> {
  return sha256Hex(canonicalJson(capsule));
}

export async function verifyCapsuleIntegrity(capsule: ProofCapsule): Promise<boolean> {
  const { integrity_sha256: digest, ...rest } = capsule;
  return digest === (await capsuleIntegrity(rest));
}

export async function buildCapsule(finding: Finding): Promise<ProofCapsule> {
  const target = finding.host + (finding.port ? ':' + finding.port : '');
  const body: Omit<ProofCapsule, 'integrity_sha256'> = {
    capsule_schema_version: CAPSULE_SCHEMA_VERSION,
    app: 'vulnexis',
    app_version: VULNEXIS_VERSION,
    created_at: new Date().toISOString(),
    finding: {
      id: finding.id,
      title: finding.vuln,
      target,
      severity: finding.severity,
      bug_class: finding.bugClass,
      evidence: finding.evidence.slice(0, 2000),
      verification_recipe: finding.recipe ?? null,
    },
    receipt: finding.receipt ?? null,
  };
  return { ...body, integrity_sha256: await capsuleIntegrity(body) };
}

/** A capsule can be re-proven only if it carries a recipe and an http target. */
export function isReplayable(capsule: ProofCapsule): boolean {
  const target = capsule.finding?.target ?? '';
  return Boolean(capsule.finding?.verification_recipe) && /^https?:\/\//i.test(target);
}

export function parseCapsule(text: string): ProofCapsule {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CapsuleError('Not a capsule: file is not valid JSON.');
  }
  const c = raw as ProofCapsule;
  if (!c || typeof c !== 'object' || c.capsule_schema_version !== CAPSULE_SCHEMA_VERSION || !c.finding) {
    throw new CapsuleError('Not a capsule: missing schema version or finding.');
  }
  if (!c.integrity_sha256) throw new CapsuleError('Not a capsule: missing integrity digest.');
  return c;
}

/**
 * Import a capsule as a finding. Honest-verdict rule: an imported receipt is
 * kept for display, but the finding lands as CANDIDATE — the verdict must be
 * re-earned locally by running Verify against the live target.
 */
export async function importCapsule(
  capsule: ProofCapsule,
  missionId: string
): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
  const valid = await verifyCapsuleIntegrity(capsule);
  if (!valid) {
    return { ok: false, error: 'Capsule integrity check FAILED — it was edited after it was built. Rejected.' };
  }
  const f = capsule.finding;
  const host = f.target.replace(/:\d+$/, '') || f.target;
  const portMatch = f.target.match(/:(\d+(?:\/\w+)?)$/);
  const { added } = addFindings([
    {
      missionId,
      sessionId: 'imported',
      host,
      port: portMatch ? portMatch[1] : undefined,
      vuln: f.title || '(imported finding)',
      severity: (f.severity as Finding['severity']) ?? 'info',
      evidence: f.evidence || '',
      status: 'candidate',
      bugClass: f.bug_class,
      recipe: (f.verification_recipe as Finding['recipe']) ?? undefined,
      receipt: capsule.receipt ?? undefined,
    },
  ]);
  if (added.length === 0) return { ok: false, error: 'Duplicate of a finding already in this mission.' };
  return { ok: true, title: f.title || host };
}

/** Trigger a browser download for the capsule JSON. */
export function downloadCapsule(capsule: ProofCapsule) {
  const blob = new Blob([JSON.stringify(capsule, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vulnexis-capsule-${capsule.finding.id}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
