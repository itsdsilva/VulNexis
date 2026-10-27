// VulNexis tool registry — ported from HexStrike AI's design:
// structured tool specs that build canonical shell commands from JSON
// parameters (instead of letting the LLM free-form every command), with
// risk classification, defaults and result caching.

import type { MissionScope } from './missions';
import { isInScope } from './missions';

export type ToolRisk = 'low' | 'medium' | 'high';

export interface ToolParam {
  name: string;
  description: string;
  default?: string;
}

export interface ToolSpec {
  name: string;
  category: 'recon' | 'web' | 'fuzz' | 'vuln' | 'osint';
  description: string;
  risk: ToolRisk;
  targetKind: 'domain' | 'url' | 'host';
  params: ToolParam[];
  build: (target: string, p: Record<string, string>) => string;
}

// Mirrors HexStrike's execute_* builders (defaults, FUZZ handling, httpx pipe)
const WORDLIST_DEFAULT = '/usr/share/wordlists/dirb/common.txt';

const args = (p: Record<string, string>, key = 'additional_args') =>
  (p[key] ?? '').trim().length ? p[key].trim().split(/\s+/) : [];

export const TOOLS: ToolSpec[] = [
  {
    name: 'nmap',
    category: 'recon',
    description: 'Port scanner and service detector.',
    risk: 'medium',
    targetKind: 'host',
    params: [
      { name: 'scan_type', description: 'Scan type flag', default: '-sV' },
      { name: 'ports', description: 'Ports, e.g. 80,443 or 1-1000' },
      { name: 'additional_args', description: 'Extra nmap flags' },
    ],
    build: (target, p) =>
      ['nmap', p.scan_type || '-sV', ...(p.ports ? ['-p', p.ports] : []), ...args(p), target]
        .filter(Boolean)
        .join(' '),
  },
  {
    name: 'masscan',
    category: 'recon',
    description: 'Fast, high-rate port scanner.',
    risk: 'medium',
    targetKind: 'host',
    params: [
      { name: 'ports', description: 'Ports to scan (required)', default: '80,443' },
      { name: 'rate', description: 'Packets per second', default: '1000' },
    ],
    build: (target, p) =>
      `masscan ${target} -p${p.ports || '80,443'} --rate=${p.rate || '1000'}`,
  },
  {
    name: 'subfinder',
    category: 'recon',
    description: 'Passive subdomain discovery.',
    risk: 'low',
    targetKind: 'domain',
    params: [{ name: 'additional_args', description: 'Extra flags' }],
    build: (target, p) => `subfinder -d ${target} ${args(p).join(' ')}`.trim(),
  },
  {
    name: 'amass',
    category: 'recon',
    description: 'In-depth DNS enumeration and network mapping.',
    risk: 'low',
    targetKind: 'domain',
    params: [
      { name: 'mode', description: 'passive | enum', default: 'passive' },
      { name: 'additional_args', description: 'Extra flags' },
    ],
    build: (target, p) =>
      `amass ${p.mode || 'passive'} -d ${target} ${args(p).join(' ')}`.trim(),
  },
  {
    name: 'theharvester',
    category: 'osint',
    description: 'Emails, subdomains and names from public sources.',
    risk: 'low',
    targetKind: 'domain',
    params: [
      { name: 'source', description: 'Data source', default: 'all' },
      { name: 'limit', description: 'Result limit', default: '500' },
    ],
    build: (target, p) =>
      `theHarvester -d ${target} -b ${p.source || 'all'} -l ${p.limit || '500'}`,
  },
  {
    name: 'httpx',
    category: 'recon',
    description: 'Probe live HTTP servers and detect technology.',
    risk: 'low',
    targetKind: 'url',
    params: [
      { name: 'additional_args', description: 'Extra flags', default: '-tech-detect -status-code' },
    ],
    build: (target, p) => `echo ${target} | httpx ${args(p).join(' ') || '-tech-detect -status-code'}`,
  },
  {
    name: 'whatweb',
    category: 'recon',
    description: 'Web technology fingerprinting.',
    risk: 'low',
    targetKind: 'url',
    params: [
      { name: 'aggression', description: 'Aggression level 1-4', default: '1' },
      { name: 'additional_args', description: 'Extra flags' },
    ],
    build: (target, p) => `whatweb -a ${p.aggression || '1'} ${args(p).join(' ')} ${target}`.trim(),
  },
  {
    name: 'wafw00f',
    category: 'recon',
    description: 'Detect and fingerprint WAFs.',
    risk: 'low',
    targetKind: 'url',
    params: [{ name: 'additional_args', description: 'Extra flags', default: '-a' }],
    build: (target, p) => `wafw00f ${args(p).join(' ') || '-a'} ${target}`.trim(),
  },
  {
    name: 'gobuster',
    category: 'fuzz',
    description: 'Directory, DNS and vhost bruteforcing.',
    risk: 'medium',
    targetKind: 'url',
    params: [
      { name: 'mode', description: 'dir | dns | vhost', default: 'dir' },
      { name: 'wordlist', description: 'Wordlist path', default: WORDLIST_DEFAULT },
      { name: 'additional_args', description: 'Extra flags' },
    ],
    build: (target, p) =>
      `gobuster ${p.mode || 'dir'} -u ${target} -w ${p.wordlist || WORDLIST_DEFAULT} ${args(p).join(' ')}`.trim(),
  },
  {
    name: 'feroxbuster',
    category: 'fuzz',
    description: 'Recursive content discovery.',
    risk: 'medium',
    targetKind: 'url',
    params: [
      { name: 'wordlist', description: 'Wordlist path', default: WORDLIST_DEFAULT },
      { name: 'additional_args', description: 'Extra flags' },
    ],
    build: (target, p) =>
      `feroxbuster -u ${target} -w ${p.wordlist || WORDLIST_DEFAULT} ${args(p).join(' ')}`.trim(),
  },
  {
    name: 'ffuf',
    category: 'fuzz',
    description: 'Fast web fuzzer. Adds /FUZZ to the URL if missing.',
    risk: 'medium',
    targetKind: 'url',
    params: [
      { name: 'wordlist', description: 'Wordlist path', default: WORDLIST_DEFAULT },
      { name: 'additional_args', description: 'Extra flags' },
    ],
    build: (target, p) => {
      let t = target;
      if (!t.includes('FUZZ')) t = t.replace(/\/?$/, '/FUZZ');
      return `ffuf -u ${t} -w ${p.wordlist || WORDLIST_DEFAULT} ${args(p).join(' ')}`.trim();
    },
  },
  {
    name: 'dirsearch',
    category: 'fuzz',
    description: 'Web path scanner.',
    risk: 'medium',
    targetKind: 'url',
    params: [{ name: 'additional_args', description: 'Extra flags' }],
    build: (target, p) => `dirsearch -u ${target} ${args(p).join(' ')}`.trim(),
  },
  {
    name: 'katana',
    category: 'web',
    description: 'Crawls and parses JavaScript for endpoints.',
    risk: 'medium',
    targetKind: 'url',
    params: [{ name: 'additional_args', description: 'Extra flags' }],
    build: (target, p) => `katana -u ${target} ${args(p).join(' ')}`.trim(),
  },
  {
    name: 'hakrawler',
    category: 'web',
    description: 'Fast web crawler for endpoints and assets.',
    risk: 'medium',
    targetKind: 'url',
    params: [{ name: 'additional_args', description: 'Extra flags' }],
    build: (target, p) => `echo ${target} | hakrawler ${args(p).join(' ')}`.trim(),
  },
  {
    name: 'gau',
    category: 'osint',
    description: 'Fetch known URLs from Wayback/Common Crawl/OTX.',
    risk: 'low',
    targetKind: 'domain',
    params: [{ name: 'additional_args', description: 'Extra flags' }],
    build: (target, p) => `gau ${target} ${args(p).join(' ')}`.trim(),
  },
  {
    name: 'waybackurls',
    category: 'osint',
    description: 'Fetch URLs from the Wayback Machine.',
    risk: 'low',
    targetKind: 'domain',
    params: [],
    build: (target) => `echo ${target} | waybackurls`,
  },
  {
    name: 'paramspider',
    category: 'web',
    description: 'Extract parameters from Wayback archives.',
    risk: 'low',
    targetKind: 'domain',
    params: [{ name: 'additional_args', description: 'Extra flags' }],
    build: (target, p) => `paramspider -d ${target} ${args(p).join(' ')}`.trim(),
  },
  {
    name: 'arjun',
    category: 'web',
    description: 'Discover hidden HTTP parameters.',
    risk: 'medium',
    targetKind: 'url',
    params: [{ name: 'additional_args', description: 'Extra flags' }],
    build: (target, p) => `arjun -u ${target} ${args(p).join(' ')}`.trim(),
  },
  {
    name: 'nuclei',
    category: 'vuln',
    description: 'Template-based vulnerability scanner.',
    risk: 'medium',
    targetKind: 'url',
    params: [
      { name: 'severity', description: 'critical,high,medium,low' },
      { name: 'tags', description: 'Template tags' },
      { name: 'additional_args', description: 'Extra flags' },
    ],
    build: (target, p) =>
      [
        'nuclei',
        '-u',
        target,
        ...(p.severity ? ['-severity', p.severity] : []),
        ...(p.tags ? ['-tags', p.tags] : []),
        ...args(p),
      ]
        .filter(Boolean)
        .join(' '),
  },
  {
    name: 'nikto',
    category: 'vuln',
    description: 'Classic web server scanner.',
    risk: 'medium',
    targetKind: 'url',
    params: [{ name: 'additional_args', description: 'Extra flags' }],
    build: (target, p) => `nikto -h ${target} ${args(p).join(' ')}`.trim(),
  },
  {
    name: 'dalfox',
    category: 'vuln',
    description: 'XSS scanner and parameter analyzer.',
    risk: 'medium',
    targetKind: 'url',
    params: [{ name: 'additional_args', description: 'Extra flags' }],
    build: (target, p) => `dalfox url ${target} ${args(p).join(' ')}`.trim(),
  },
  {
    name: 'wpscan',
    category: 'vuln',
    description: 'WordPress vulnerability scanner.',
    risk: 'high',
    targetKind: 'url',
    params: [{ name: 'additional_args', description: 'Extra flags', default: '--enumerate vp,vt,u' }],
    build: (target, p) =>
      `wpscan --url ${target} ${args(p).join(' ') || '--enumerate vp,vt,u'}`.trim(),
  },
  {
    name: 'sqlmap',
    category: 'vuln',
    description: 'SQL injection detection and exploitation.',
    risk: 'high',
    targetKind: 'url',
    params: [{ name: 'additional_args', description: 'Extra flags', default: '--batch --random-agent' }],
    build: (target, p) => `sqlmap -u ${target} ${args(p).join(' ') || '--batch --random-agent'}`.trim(),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export class ToolError extends Error {}

/** Build a canonical command for a registered tool from JSON parameters. */
export function buildToolCommand(
  name: string,
  target: string,
  params: Record<string, unknown> | undefined
): { spec: ToolSpec; command: string } {
  const spec = BY_NAME.get(name);
  if (!spec) throw new ToolError(`Unknown tool: ${name}. Available: ${TOOLS.map((t) => t.name).join(', ')}`);
  const t = target.trim();
  if (!t) throw new ToolError(`${name}: target is required`);
  if (spec.targetKind === 'url' && !/^https?:\/\//i.test(t)) {
    throw new ToolError(`${name} expects a URL (http/https). Got: ${t}`);
  }
  if (spec.targetKind === 'domain' && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(t)) {
    throw new ToolError(`${name} expects a domain name. Got: ${t}`);
  }
  const merged: Record<string, string> = {};
  for (const p of spec.params) {
    const v = params?.[p.name];
    merged[p.name] = (typeof v === 'string' && v.trim()) || p.default || '';
  }
  // never let params inject extra shell words through target
  const safeTarget = t.replace(/["'`;$&|]/g, '');
  return { spec, command: spec.build(safeTarget, merged) };
}

/** HexStrike-style result cache: identical commands replayed within TTL. */
const cache = new Map<string, { at: number; value: string }>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const CACHE_MAX = 200;

export function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

export function cacheSet(key: string, value: string) {
  if (cache.size >= CACHE_MAX) {
    // evict oldest
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

/** Extract a hostname/IP from a target that may be a URL or host:port. */
export function hostnameOf(target: string): string {
  const t = target.trim();
  try {
    if (/^https?:\/\//i.test(t)) return new URL(t).hostname;
  } catch {
    /* fall through */
  }
  return t.replace(/\/.*$/, '').replace(/:\d+$/, '');
}

/** Scope gate: only allow tools to run against in-scope targets. */
export function toolTargetInScope(target: string, scope: MissionScope): boolean {
  return isInScope(hostnameOf(target), scope);
}
