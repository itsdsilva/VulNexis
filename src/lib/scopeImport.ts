// Platform scope import, adapted from pentest-ai's `ptai bounty import`:
// paste a program policy (or its scope section) and the scope is extracted
// structurally. A regex heuristic parses well-formed policies offline; an LLM
// call handles messier text when a key is available. Fail-closed UX: the
// parsed scope lands in the form fields for human review BEFORE the mission is
// created — nothing auto-applies.

import { callLLM } from './llm';
import type { MissionScope } from './missions';

export interface ParsedScope {
  domains: string[];
  ips: string[];
  wildcards: string[];
  outOfScope: string[];
}

function asList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

async function llmScopeFromText(text: string): Promise<ParsedScope> {
  const res = await callLLM([
    {
      role: 'system',
      content:
        'You extract the testing scope from bug-bounty program policies. Reply ONLY with a single JSON object (no markdown, no fences): {"domains":["..."],"ips":["..."],"wildcards":["*.example.com"],"out_of_scope":["..."]}.\n' +
        'Rules: keep entries exactly as the policy states them; put "*.domain" patterns under wildcards; anything the policy excludes (mail.*, .gov, 3rd-party hosts) goes in out_of_scope; do not invent targets; empty arrays are fine.',
    },
    { role: 'user', content: `PROGRAM POLICY:\n${text}` },
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.content.trim());
  } catch {
    const m = res.content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Scope model did not return valid JSON.');
    parsed = JSON.parse(m[0]);
  }
  const p = parsed as Record<string, unknown>;
  const out: ParsedScope = {
    domains: asList(p?.domains),
    ips: asList(p?.ips),
    wildcards: asList(p?.wildcards),
    outOfScope: asList(p?.out_of_scope),
  };
  if (!out.domains.length && !out.ips.length && !out.wildcards.length) {
    throw new Error('No in-scope targets found in that text.');
  }
  return out;
}

// --- Offline heuristic parser -------------------------------------------------

const DOMAIN_RE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.?$/i;
const IP_RE = /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/;

function classify(tokens: string[], scope: ParsedScope, outOfScope: boolean) {
  for (let raw of tokens) {
    // Strip URL scheme and path, keep host[:port] — only for actual URLs, so
    // CIDR ranges like 198.51.100.0/24 survive.
    let t = /^https?:\/\//i.test(raw) ? raw.replace(/^https?:\/\//i, '').split('/')[0] : raw;
    // Strip a trailing :port (and optional service suffix).
    t = t.replace(/:\d+(?:\/\w+)?$/, '');
    // Strip surrounding punctuation left by list formatting.
    t = t.replace(/^[("'`[\]]+/, '').replace(/[)"'`\],.]+$/, '');
    if (!t || t.length > 253) continue;
    const isIp = IP_RE.test(t);
    const isDomain = !isIp && DOMAIN_RE.test(t);
    if (!isIp && !isDomain) continue;
    if (outOfScope) {
      scope.outOfScope.push(t);
    } else if (isIp) {
      scope.ips.push(t);
    } else if (t.startsWith('*.')) {
      scope.wildcards.push(t);
    } else {
      scope.domains.push(t);
    }
  }
}

/** Split the policy text at the first out-of-scope marker. */
function splitSections(text: string): { inText: string; outText: string } {
  const m = /out[\s-]*of[\s-]*scope|exclusions?/i.exec(text);
  if (m && m.index !== undefined) {
    return { inText: text.slice(0, m.index), outText: text.slice(m.index + m[0].length) };
  }
  return { inText: text, outText: '' };
}

function tokenize(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*[-–•·]+\s*/, '')) // list bullets, but keep "*." wildcards
    .join('\n')
    .split(/[\s,;|]+/)
    .filter(Boolean);
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

export function heuristicScopeFromText(policyText: string): ParsedScope {
  const text = policyText.trim();
  const { inText, outText } = splitSections(text);
  const scope: ParsedScope = { domains: [], ips: [], wildcards: [], outOfScope: [] };
  classify(tokenize(inText), scope, false);
  classify(tokenize(outText), scope, true);
  scope.domains = dedupe(scope.domains);
  scope.ips = dedupe(scope.ips);
  scope.wildcards = dedupe(scope.wildcards);
  scope.outOfScope = dedupe(scope.outOfScope);
  return scope;
}

export async function importScopeFromText(policyText: string): Promise<ParsedScope> {
  const text = policyText.trim().slice(0, 15000);
  if (!text) throw new Error('Paste the program policy text first.');
  let llmError: unknown = null;
  try {
    return await llmScopeFromText(text);
  } catch (e) {
    llmError = e;
  }
  const heuristic = heuristicScopeFromText(text);
  if (heuristic.domains.length || heuristic.ips.length || heuristic.wildcards.length) return heuristic;
  throw llmError ?? new Error('No in-scope targets found in that text.');
}

/** Convert a parsed scope into the four textarea strings the mission form uses. */
export function scopeToForm(scope: MissionScope) {
  return {
    domains: scope.domains.join('\n'),
    ips: scope.ips.join('\n'),
    wildcards: scope.wildcards.join('\n'),
    outOfScope: scope.outOfScope.join('\n'),
  };
}
