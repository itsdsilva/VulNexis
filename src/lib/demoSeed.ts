// First-run demo data: one bug-bounty mission with a recon session and a few
// findings so the workspace isn't empty on a fresh install. Runs at most once
// and never overwrites real missions or sessions.

import { loadMissions, saveMissions, type Finding, type Mission } from './missions';
import { loadSessions, saveSessions, type Session } from './store';

const SEEDED_KEY = 'vulnexis.demoSeeded_v1';
const WORKSPACE_KEY = 'vulnexis.workspace';

function demoTimestamp(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - 42);
  return d.toISOString();
}

export function maybeSeedDemo() {
  try {
    if (localStorage.getItem(SEEDED_KEY)) return;
    localStorage.setItem(SEEDED_KEY, '1');
    if (loadMissions().length > 0) return;
    if (loadSessions().length > 0) return;

    const createdAt = demoTimestamp();
    const mission: Mission = {
      id: 'm_demo_acme',
      name: 'Demo — Acme Bug Bounty',
      scope: {
        domains: ['app.acme.test'],
        ips: [],
        wildcards: ['*.acme.test'],
        outOfScope: ['admin.acme.test'],
      },
      roeConfirmed: true,
      createdAt,
      status: 'active',
      intensity: 'normal',
      kind: 'bugbounty',
    };

    const session: Session = {
      id: 's_demo_recon',
      missionId: mission.id,
      name: 'Recon pass',
      agent: 'recon',
      createdAt,
      updatedAt: createdAt,
      messages: [
        { role: 'user', text: 'Map the attack surface for app.acme.test', ts: createdAt },
        {
          role: 'assistant',
          text: '$ nmap -sV -T3 --top-ports 1000 app.acme.test\nTop-ports service scan, normal intensity.\n[risk: low]',
          ts: createdAt,
        },
        {
          role: 'tool',
          text: [
            'Nmap scan report for app.acme.test (203.0.113.10)',
            'Host is up (0.021s latency).',
            'PORT     STATE SERVICE  VERSION',
            '22/tcp   open  ssh      OpenSSH 8.9p1 Ubuntu 3ubuntu0.6',
            '80/tcp   open  http     nginx 1.24.0',
            '443/tcp  open  ssl/http nginx 1.24.0',
            '8443/tcp open  https-alt',
            '',
            'Nmap scan report for api.acme.test (203.0.113.11)',
            'Host is up (0.019s latency).',
            '443/tcp  open  ssl/http nginx 1.24.0',
          ].join('\n'),
          ts: createdAt,
        },
        {
          role: 'assistant',
          text: '$ httpx -silent -status-code -title -u https://app.acme.test -u https://api.acme.test/v2/status\n[risk: low]',
          ts: createdAt,
        },
        {
          role: 'tool',
          text: [
            'https://app.acme.test [200] [Acme Portal] [nginx/1.24.0]',
            'https://api.acme.test/v2/status [401] [Unauthorized]',
          ].join('\n'),
          ts: createdAt,
        },
        {
          role: 'tool',
          text: [
            'HTTP/1.1 200 OK',
            'Server: nginx/1.24.0',
            'Content-Type: text/html; charset=utf-8',
            '',
            '<!doctype html><html><head><title>Acme Portal</title></head>',
            '<body>Welcome back</body></html>',
          ].join('\n'),
          ts: createdAt,
        },
      ],
    };

    const findings: Finding[] = [
      {
        id: 'f_demo_idor',
        missionId: mission.id,
        sessionId: session.id,
        host: 'app.acme.test',
        port: '443',
        vuln: 'IDOR in /api/v1/invoices/{id} exposes other tenants invoices',
        severity: 'critical',
        evidence:
          'GET /api/v1/invoices/1042 as tenant B returned invoice JSON for tenant A including billing address and card last4.',
        createdAt,
        status: 'verified',
        bugClass: 'broken-access-control',
        recipe: {
          kind: 'differential',
          attack: 'curl -s -H "Authorization: Bearer $TOKEN_B" https://app.acme.test/api/v1/invoices/1042',
          control: 'curl -s -H "Authorization: Bearer $TOKEN_B" https://app.acme.test/api/v1/invoices/1043',
          marker: 'tenant_a_email',
          description: 'Attack request returns tenant A data; control returns 404.',
        },
        receipt: {
          schemaVersion: 1,
          findingId: 'f_demo_idor',
          verdict: 'verified',
          oracleKind: 'differential',
          evidence: {
            diff: '- 404 tenant_mismatch\n+ 200 {"tenant":"tenant_a","email":"a@acme.test"}',
            request: 'GET /api/v1/invoices/1042',
          },
          replay: { successes: 5, attempts: 5 },
          createdAt,
        },
      },
      {
        id: 'f_demo_xss',
        missionId: mission.id,
        sessionId: session.id,
        host: 'app.acme.test',
        port: '443',
        vuln: 'Reflected XSS in search query parameter',
        severity: 'high',
        evidence: 'GET /search?q=<svg/onload=alert(1)> returned the payload unescaped inside the results header.',
        createdAt,
        status: 'candidate',
        bugClass: 'xss',
      },
      {
        id: 'f_demo_banner',
        missionId: mission.id,
        sessionId: session.id,
        host: 'api.acme.test',
        port: '443',
        vuln: 'Server banner discloses nginx 1.24.0',
        severity: 'info',
        evidence: 'Server: nginx/1.24.0',
        createdAt,
        status: 'candidate',
        bugClass: 'info-disclosure',
      },
    ];

    saveMissions([mission]);
    saveSessions([session]);
    localStorage.setItem('vulnexis.findings', JSON.stringify(findings));
    if (!localStorage.getItem(WORKSPACE_KEY)) localStorage.setItem(WORKSPACE_KEY, 'bugbounty');
  } catch {
    // Demo seeding must never break app startup.
  }
}
