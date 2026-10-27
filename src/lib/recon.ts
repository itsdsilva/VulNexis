// Deterministic recon extraction: parse nmap / httpx / curl output from a
// session's tool messages into hosts, ports and HTTP endpoints. No LLM calls.

import type { StoredMsg } from './store';

export interface ReconPort {
  host: string;
  port: string;
  proto: string;
  service: string;
  version?: string;
}

export interface ReconEndpoint {
  url: string;
  host: string;
  status?: number;
  title?: string;
}

export interface ReconHost {
  host: string;
  ips: string[];
  ports: ReconPort[];
  endpoints: ReconEndpoint[];
}

export interface Recon {
  hosts: ReconHost[];
  ports: ReconPort[];
  endpoints: ReconEndpoint[];
  parsedMessages: number;
}

const NMAP_HOST = /^Nmap scan report for (\S+?)(?: \((\d{1,3}(?:\.\d{1,3}){3})\))?\s*$/i;
const NMAP_PORT = /^(\d{1,5})\/(tcp|udp)\s+(open|open\|filtered|filtered)\s+(\S+)(?:\s+(.*))?$/i;
const URL_RE = /https?:\/\/[^\s"'<>)\]},]+/g;
const TITLE_RE = /<title[^>]*>([^<]{1,160})<\/title>/i;
const STATUS_LINE_RE = /^(https?:\/\/\S+?)(?:\s+|\[)(\d{3})\b/i;

function trimUrl(u: string): string {
  return u.replace(/[.;:,]+$/, '');
}

function urlHost(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function collectRecon(messages: StoredMsg[]): Recon {
  const hostMap = new Map<string, ReconHost>();
  const seenPorts = new Set<string>();
  const seenUrls = new Set<string>();
  let parsedMessages = 0;

  const hostFor = (name: string): ReconHost => {
    const key = name.toLowerCase();
    let h = hostMap.get(key);
    if (!h) {
      h = { host: name, ips: [], ports: [], endpoints: [] };
      hostMap.set(key, h);
    }
    return h;
  };

  const addPort = (hostName: string, p: ReconPort) => {
    const host = hostFor(hostName);
    const key = `${hostName.toLowerCase()}|${p.proto}|${p.port}`;
    if (seenPorts.has(key)) return;
    seenPorts.add(key);
    host.ports.push(p);
  };

  const addEndpoint = (u: string, opts: { status?: number; title?: string } = {}) => {
    const clean = trimUrl(u);
    const h = urlHost(clean);
    if (!h) return;
    if (seenUrls.has(clean)) {
      const host = hostFor(h);
      const existing = host.endpoints.find((e) => e.url === clean);
      if (existing && opts.status !== undefined) existing.status = opts.status;
      return;
    }
    seenUrls.add(clean);
    const endpoint: ReconEndpoint = { url: clean, host: h, ...opts };
    hostFor(h).endpoints.push(endpoint);
  };

  for (const m of messages) {
    if (m.role !== 'tool') continue;
    const text = m.text;
    if (!text) continue;
    let touched = false;

    let currentHost: string | null = null;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      const hm = line.match(NMAP_HOST);
      if (hm) {
        const name = hm[1].toLowerCase() === 'localhost' ? hm[2] ?? hm[1] : hm[1];
        currentHost = name;
        const host = hostFor(name);
        if (hm[2] && !host.ips.includes(hm[2])) host.ips.push(hm[2]);
        touched = true;
        continue;
      }

      const pm = line.match(NMAP_PORT);
      if (pm && currentHost && pm[3].toLowerCase().startsWith('open')) {
        addPort(currentHost, {
          host: currentHost,
          port: pm[1],
          proto: pm[2].toLowerCase(),
          service: pm[4],
          version: pm[5]?.trim() || undefined,
        });
        touched = true;
        continue;
      }
    }

    const title = text.match(TITLE_RE)?.[1]?.trim();
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const sm = line.match(STATUS_LINE_RE);
      if (sm) {
        addEndpoint(sm[1], { status: Number(sm[2]), title });
        touched = true;
      }
    }
    for (const u of text.match(URL_RE) ?? []) {
      addEndpoint(u, { title });
      touched = true;
    }
    if (touched) parsedMessages++;
  }

  const hosts = [...hostMap.values()]
    .map((h) => ({
      ...h,
      ports: [...h.ports].sort((a, b) => Number(a.port) - Number(b.port)),
      endpoints: [...h.endpoints].sort((a, b) => a.url.localeCompare(b.url)),
    }))
    .sort((a, b) => a.host.localeCompare(b.host));

  const ports = hosts.flatMap((h) => h.ports);
  const endpoints = hosts.flatMap((h) => h.endpoints);

  return { hosts, ports, endpoints, parsedMessages };
}

export function reconSummary(recon: Recon) {
  return {
    hosts: recon.hosts.length,
    ports: recon.ports.length,
    endpoints: recon.endpoints.length,
  };
}
