export type MissionKind = 'pentest' | 'bugbounty';

export interface MissionScope {
  domains: string[];
  ips: string[];
  wildcards: string[];
  outOfScope: string[];
}

export interface Mission {
  id: string;
  name: string;
  scope: MissionScope;
  roeConfirmed: boolean;
  createdAt: string;
  status: 'active' | 'completed' | 'archived';
  intensity?: Intensity; // pentest-ai style noise budget; default 'normal'
  kind?: MissionKind; // existing missions default to 'pentest'
}

export function missionKind(m: Mission): MissionKind {
  return m.kind ?? 'pentest';
}

export type Intensity = 'stealth' | 'safe' | 'normal' | 'aggressive';

export function parseScopeText(domains: string, ips: string, wildcards: string, outOfScope: string): MissionScope {
  const split = (s: string) =>
    s
      .split(/[\n,;]+/)
      .map((x) => {
        let t = x.trim();
        if (!t) return '';
        try {
          if (/^https?:\/\//i.test(t)) {
            const u = new URL(t);
            t = u.hostname;
          }
        } catch {
          /* fall through */
        }
        t = t.replace(/\/.*$/, '').replace(/:\d+$/, '').toLowerCase();
        return t;
      })
      .filter((x) => x.length > 0);
  return {
    domains: split(domains),
    ips: split(ips),
    wildcards: split(wildcards),
    outOfScope: split(outOfScope),
  };
}

export function scopeToText(scope: MissionScope) {
  return {
    domains: scope.domains.join('\n'),
    ips: scope.ips.join('\n'),
    wildcards: scope.wildcards.join('\n'),
    outOfScope: scope.outOfScope.join('\n'),
  };
}

/** Checks if a target (host or IP) is in scope for the mission. Out-of-scope always wins. */
export function isInScope(target: string, scope: MissionScope): boolean {
  let t = target.trim().toLowerCase();
  if (!t) return false;
  try {
    if (/^https?:\/\//i.test(t)) {
      t = new URL(t).hostname.toLowerCase();
    }
  } catch {
    /* fall through */
  }
  t = t.replace(/\/.*$/, '').replace(/:\d+$/, '');

  const matches = (pattern: string) => {
    let p = pattern.trim().toLowerCase();
    if (!p) return false;
    try {
      if (/^https?:\/\//i.test(p)) {
        p = new URL(p).hostname.toLowerCase();
      }
    } catch {
      /* fall through */
    }
    p = p.replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (p === t) return true;
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return t === base || t.endsWith('.' + base);
    }
    // CIDR-lite: treat prefix like 192.168.1. as match for any host in it
    if (p.endsWith('.')) return t.startsWith(p);
    return false;
  };

  if (scope.outOfScope.some(matches)) return false;
  return scope.domains.some(matches) || scope.ips.some(matches) || scope.wildcards.some(matches);
}

/** Load and save missions to localStorage (later moves to SQLite) */
const KEY = 'vulnexis_missions_v1';

const normalizeScope = (scope: MissionScope): MissionScope => {
  const norm = (s: string) => {
    let t = s.trim().toLowerCase();
    if (!t) return '';
    try {
      if (/^https?:\/\//i.test(t)) t = new URL(t).hostname.toLowerCase();
    } catch {
      /* ignore */
    }
    t = t.replace(/\/.*$/, '').replace(/:\d+$/, '');
    return t;
  };
  return {
    domains: (scope.domains || []).map(norm).filter(Boolean),
    ips: (scope.ips || []).map(norm).filter(Boolean),
    wildcards: (scope.wildcards || []).map(norm).filter(Boolean),
    outOfScope: (scope.outOfScope || []).map(norm).filter(Boolean),
  };
};

export function loadMissions(): Mission[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Mission[];
      if (Array.isArray(parsed)) {
        const fixed = parsed.map((m) => ({ ...m, scope: normalizeScope(m.scope) }));
        // Save back normalized form
        localStorage.setItem(KEY, JSON.stringify(fixed));
        return fixed;
      }
      return parsed;
    }
    // Migrate missions saved under the old store.ts key
    const legacy = localStorage.getItem('vulnexis.missions');
    if (legacy) {
      const parsed = JSON.parse(legacy) as Mission[];
      if (Array.isArray(parsed)) {
        const fixed = parsed.map((m) => ({ ...m, scope: normalizeScope(m.scope) }));
        localStorage.setItem(KEY, JSON.stringify(fixed));
        return fixed;
      }
    }
    return [];
  } catch {
    return [];
  }
}

export function saveMissions(missions: Mission[]) {
  localStorage.setItem(KEY, JSON.stringify(missions));
}

export function updateMission(updated: Mission) {
  const all = loadMissions();
  const idx = all.findIndex((m) => m.id === updated.id);
  if (idx >= 0) {
    all[idx] = { ...updated };
    saveMissions(all);
    return all;
  }
  return all;
}

export function deleteMission(id: string) {
  const all = loadMissions().filter((m) => m.id !== id);
  saveMissions(all);
  return all;
}

export function newMissionId(): string {
  return 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// Findings: structured vulnerabilities extracted from session tool output.
// Stored globally, filtered per mission.
// ---------------------------------------------------------------------------

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export const SEVERITY_STYLE: Record<Severity, string> = {
  critical: 'bg-accent-red/20 text-accent-red border-accent-red/50',
  high: 'bg-accent-red/10 text-accent-red border-accent-red/30',
  medium: 'bg-accent-amber/10 text-accent-amber border-accent-amber/30',
  low: 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30',
  info: 'bg-bg-tertiary text-text-secondary border-border',
};

export interface Finding {
  id: string;
  missionId: string;
  sessionId: string;
  host: string;
  port?: string;
  vuln: string;
  severity: Severity;
  evidence: string;
  createdAt: string;
  // pentest-ai verification: a finding stays "candidate" until a machine
  // oracle reproduces it. The LLM cannot award a verified verdict.
  status?: FindingStatus;
  bugClass?: string;
  recipe?: OracleRecipe;
  receipt?: Receipt;
}

export type FindingStatus = 'candidate' | 'verified' | 'unverifiable';

export type OracleKind =
  | 'unescaped_reflection'
  | 'differential'
  | 'idempotent_replay'
  | 'server_state';

export interface OracleRecipe {
  kind: OracleKind;
  // Attack request/command — repeated N times by the oracle.
  attack: string;
  // Control request that must NOT demonstrate the weakness (optional for
  // unescaped_reflection). Differential oracles require it.
  control?: string;
  // Marker/canary token expected raw in the attack response (reflection), or
  // expected present in attack and absent in control (differential).
  marker?: string;
  description?: string;
}

export interface Receipt {
  schemaVersion: number;
  findingId: string;
  verdict: 'verified' | 'candidate';
  oracleKind: OracleKind;
  evidence: { diff?: string; request?: string; response?: string };
  replay: { successes: number; attempts: number };
  createdAt: string;
}

const FINDINGS_KEY = 'vulnexis.findings';

export function loadFindings(): Finding[] {
  try {
    const raw = localStorage.getItem(FINDINGS_KEY);
    return raw ? (JSON.parse(raw) as Finding[]) : [];
  } catch {
    return [];
  }
}

export function saveFindings(findings: Finding[]) {
  localStorage.setItem(FINDINGS_KEY, JSON.stringify(findings));
}

export function findingsFor(missionId: string): Finding[] {
  return loadFindings().filter((f) => f.missionId === missionId);
}

/** Adds findings, deduping on mission+host+port+vuln. Same key upgrades severity if worse. */
export function addFindings(incoming: Omit<Finding, 'id' | 'createdAt'>[]): { added: Finding[]; updated: number } {
  const all = loadFindings();
  const added: Finding[] = [];
  let updated = 0;
  for (const f of incoming) {
    const dup = all.find(
      (x) =>
        x.missionId === f.missionId &&
        x.host === f.host &&
        (x.port ?? '') === (f.port ?? '') &&
        x.vuln.trim().toLowerCase() === f.vuln.trim().toLowerCase()
    );
    if (dup) {
      if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[dup.severity]) {
        dup.severity = f.severity;
        updated++;
      }
      if (f.evidence && f.evidence.length > dup.evidence.length) dup.evidence = f.evidence;
      continue;
    }
    const full: Finding = {
      ...f,
      id: 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      createdAt: new Date().toISOString(),
    };
    all.push(full);
    added.push(full);
  }
  saveFindings(all);
  return { added, updated };
}

export function deleteFinding(id: string) {
  saveFindings(loadFindings().filter((f) => f.id !== id));
}

/** Persists a finding update by id (used by the verification oracles). */
export function updateFinding(id: string, patch: Partial<Finding>): Finding | undefined {
  const all = loadFindings();
  const idx = all.findIndex((f) => f.id === id);
  if (idx === -1) return undefined;
  all[idx] = { ...all[idx], ...patch };
  saveFindings(all);
  return all[idx];
}
