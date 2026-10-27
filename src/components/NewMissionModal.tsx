import { useState } from 'react';
import { newMissionId, parseScopeText, type Intensity, type Mission, type MissionKind } from '../lib/missions';
import { importScopeFromText, scopeToForm } from '../lib/scopeImport';

interface NewMissionModalProps {
  kind: MissionKind;
  onClose: () => void;
  onCreate: (mission: Mission) => void;
}

const INTENSITIES: { value: Intensity; label: string; hint: string }[] = [
  { value: 'stealth', label: 'Stealth', hint: 'Passive-first, rate-limited, single requests (replay N=2)' },
  { value: 'safe', label: 'Safe', hint: 'Read-only probing, nothing state-changing (replay N=2)' },
  { value: 'normal', label: 'Normal', hint: 'Balanced methodology, standard scan speeds (replay N=3)' },
  { value: 'aggressive', label: 'Aggressive', hint: 'Broader, faster scans — never destructive (replay N=5)' },
];

export default function NewMissionModal({ kind, onClose, onCreate }: NewMissionModalProps) {
  const isBB = kind === 'bugbounty';
  const [name, setName] = useState('');
  const [domains, setDomains] = useState('');
  const [ips, setIps] = useState('');
  const [wildcards, setWildcards] = useState('');
  const [outOfScope, setOutOfScope] = useState('');
  const [intensity, setIntensity] = useState<Intensity>('normal');
  const [authorized, setAuthorized] = useState(false);
  const [inScopeOnly, setInScopeOnly] = useState(false);
  const [responsible, setResponsible] = useState(false);
  const [labOnly, setLabOnly] = useState(false);
  const [error, setError] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [policyText, setPolicyText] = useState('');
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState('');

  const allChecked = authorized && inScopeOnly && responsible && labOnly;

  const doImport = async () => {
    setImporting(true);
    setImportNote('');
    try {
      const parsed = await importScopeFromText(policyText);
      const form = scopeToForm(parsed);
      setDomains(form.domains);
      setIps(form.ips);
      setWildcards(form.wildcards);
      setOutOfScope(form.outOfScope);
      setShowImport(false);
      setImportNote('Scope parsed — review the fields below before creating the mission.');
    } catch (e) {
      setImportNote(String(e));
    } finally {
      setImporting(false);
    }
  };

  const create = () => {
    const scope = parseScopeText(domains, ips, wildcards, outOfScope);
    const total = scope.domains.length + scope.ips.length + scope.wildcards.length;
    if (!name.trim()) {
      setError('Give your mission a name.');
      return;
    }
    if (total === 0) {
      setError('Add at least one in-scope target (domain, IP, or wildcard).');
      return;
    }
    if (!allChecked) {
      setError('You must confirm all authorization statements.');
      return;
    }
    const mission: Mission = {
      id: newMissionId(),
      name: name.trim(),
      scope,
      roeConfirmed: true,
      createdAt: new Date().toISOString(),
      status: 'active',
      intensity,
      kind,
    };
    onCreate(mission);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="w-[620px] max-h-[90vh] overflow-y-auto bg-bg-secondary border border-border rounded-lg">
        <div className="h-10 border-b border-border flex items-center justify-between px-4">
          <span className="text-sm font-semibold">
            {isBB ? '🐞 New Bug Bounty Program' : '🎯 New Mission'}
          </span>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-base">×</button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <div className="flex items-center justify-between">
              <label className="text-xs text-text-secondary">Mission name</label>
              <button
                onClick={() => setShowImport((s) => !s)}
                className="text-xs text-accent-cyan hover:text-accent-cyan/80"
                title="Paste a bug bounty program policy and let the model extract the scope — you review it before the mission is created"
              >
                ⇩ Import scope from policy
              </button>
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isBB ? 'e.g. HackerOne program X, Bugcrowd program Y' : 'e.g. Juice Shop Lab, internal network test'}
              className="w-full mt-1 px-2 py-1.5 bg-bg-tertiary border border-border rounded text-xs"
            />
          </div>

          {showImport && (
            <div className="border border-accent-cyan/30 bg-accent-cyan/5 rounded p-3 space-y-2">
              <div className="text-xs text-text-secondary">
                Paste the program policy (scope section is enough). Parsed targets fill the fields for your review —
                nothing is applied automatically.
              </div>
              <textarea
                value={policyText}
                onChange={(e) => setPolicyText(e.target.value)}
                rows={5}
                placeholder="e.g. In scope: *.example.com, api.example.com, 198.51.100.0/24 ... Out of scope: mail.example.com, support.example.com"
                className="w-full px-2 py-1.5 bg-bg-tertiary border border-border rounded text-xs font-mono"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={doImport}
                  disabled={importing || !policyText.trim()}
                  className="px-2 py-1 rounded border border-accent-cyan/40 text-accent-cyan hover:bg-accent-cyan/10 disabled:opacity-40 text-xs"
                >
                  {importing ? 'Parsing…' : 'Parse scope'}
                </button>
                {importNote && <span className="text-[10px] text-text-muted truncate">{importNote}</span>}
              </div>
            </div>
          )}

          <div>
            <label className="text-xs text-text-secondary">Intensity (noise budget)</label>
            <div className="grid grid-cols-4 gap-2 mt-1">
              {INTENSITIES.map((i) => (
                <button
                  key={i.value}
                  onClick={() => setIntensity(i.value)}
                  title={i.hint}
                  className={`px-2 py-1.5 rounded text-xs border ${
                    intensity === i.value
                      ? 'border-accent-cyan/60 bg-accent-cyan/10 text-accent-cyan'
                      : 'border-border text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {i.label}
                </button>
              ))}
            </div>
            <div className="text-[10px] text-text-muted mt-1">
              {INTENSITIES.find((i) => i.value === intensity)?.hint} — guides the agent and sets oracle replay counts.
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-text-secondary">In-scope domains (one per line)</label>
              <textarea
                value={domains}
                onChange={(e) => setDomains(e.target.value)}
                rows={3}
                placeholder="example.com&#10;api.example.com"
                className="w-full mt-1 px-2 py-1.5 bg-bg-tertiary border border-border rounded text-xs font-mono"
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary">In-scope IPs (one per line)</label>
              <textarea
                value={ips}
                onChange={(e) => setIps(e.target.value)}
                rows={3}
                placeholder="192.168.1.10&#10;10.0.0.5"
                className="w-full mt-1 px-2 py-1.5 bg-bg-tertiary border border-border rounded text-xs font-mono"
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary">Wildcards</label>
              <textarea
                value={wildcards}
                onChange={(e) => setWildcards(e.target.value)}
                rows={2}
                placeholder="*.example.com"
                className="w-full mt-1 px-2 py-1.5 bg-bg-tertiary border border-border rounded text-xs font-mono"
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary">Out of scope (one per line)</label>
              <textarea
                value={outOfScope}
                onChange={(e) => setOutOfScope(e.target.value)}
                rows={2}
                placeholder="mail.example.com"
                className="w-full mt-1 px-2 py-1.5 bg-bg-tertiary border border-border rounded text-xs font-mono"
              />
            </div>
          </div>

          <div className="border border-accent-amber/40 bg-accent-amber/5 rounded p-3 space-y-2">
            <div className="text-xs font-semibold text-accent-amber">⚠ Authorization &amp; Rules of Engagement</div>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} className="mt-0.5" />
              <span>I have explicit written authorization (program scope / ROE / lab ownership) to test every target listed above.</span>
            </label>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={inScopeOnly} onChange={(e) => setInScopeOnly(e.target.checked)} className="mt-0.5" />
              <span>I will only test targets in this scope. Out-of-scope targets will be blocked by VulNexis.</span>
            </label>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={responsible} onChange={(e) => setResponsible(e.target.checked)} className="mt-0.5" />
              <span>I will follow responsible disclosure and the program's rules.</span>
            </label>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={labOnly} onChange={(e) => setLabOnly(e.target.checked)} className="mt-0.5" />
              <span>I understand VulNexis is for learning and authorized testing only — not for illegal use.</span>
            </label>
          </div>

          {error && <div className="text-xs text-accent-red">{error}</div>}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary rounded border border-border">
              Cancel
            </button>
            <button
              onClick={create}
              className="px-4 py-1.5 text-xs font-semibold bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/40 rounded hover:bg-accent-cyan/25"
            >
              {isBB ? 'Create Program' : 'Create Mission'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
