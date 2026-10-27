// Minimal, dependency-free markdown renderer for chat replies and reports.
// Supports fenced code, headings, lists, blockquotes, rules and inline
// bold/italic/code/links. Never uses dangerouslySetInnerHTML.

import type { ReactNode } from 'react';

const INLINE_RE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\n]+\*)/g;

function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) nodes.push(text.slice(last, idx));
    const tok = m[0];
    const key = `${keyBase}-i${n++}`;
    if (tok.startsWith('**')) {
      nodes.push(
        <strong key={key} className="font-semibold text-text-primary">
          {tok.slice(2, -2)}
        </strong>
      );
    } else if (tok.startsWith('`')) {
      nodes.push(
        <code key={key} className="px-1 py-0.5 rounded-sm bg-bg-tertiary text-[0.9em] font-mono text-text-primary/90">
          {tok.slice(1, -1)}
        </code>
      );
    } else if (tok.startsWith('[')) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      nodes.push(
        <a
          key={key}
          href={mm?.[2]}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent-cyan hover:text-accent-cyan/80 underline underline-offset-2"
        >
          {mm?.[1]}
        </a>
      );
    } else {
      nodes.push(
        <em key={key} className="italic text-text-primary/90">
          {tok.slice(1, -1)}
        </em>
      );
    }
    last = idx + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes('|')) return false;
  // Must be mostly dashes, colons, spaces, pipes
  const stripped = t.replace(/\|/g, '').replace(/:/g, '').replace(/-/g, '').replace(/\s/g, '');
  return stripped.length === 0 && t.includes('-');
}

function parseTableRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  // Simple split by | (sufficient for basic tables)
  return l.split('|').map((c) => c.trim());
}

export default function Markdown({ text }: { text: string }) {
  // Strip common internal tool traces that leak from some agents
  let clean = text || '';
  clean = clean.replace(/\[pasted-context-[^\]]+\]\s*/gi, '');
  clean = clean.replace(/Called the Read tool[^\n]*/gi, '');
  clean = clean.replace(/Called the .*? tool[^\n]*/gi, '');
  clean = clean.replace(/Read tool with the following input[^\n]*/gi, '');
  clean = clean.replace(/^\s*\{\s*"filePath"[\s\S]*?\}\s*$/gim, '');
  const lines = clean.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Table detection
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headerCells = parseTableRow(line);
      i += 2; // skip header and separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && !isTableSeparator(lines[i]) && lines[i].trim() !== '') {
        // Stop if it's a new block type
        if (/^#{1,6}\s+/.test(lines[i].trim()) || /^\s*```/.test(lines[i].trim())) break;
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={`b${key++}`} className="my-3 overflow-x-auto rounded-lg border border-bordermuted">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-border bg-bg-tertiary/50">
                {headerCells.map((cell, ci) => (
                  <th key={ci} className="text-left px-3 py-2 text-text-primary font-medium">
                    {inline(cell, `t${key}-h${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="border-b border-bordermuted hover:bg-bg-tertiary/40 transition-colors">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-2 align-top text-text-secondary leading-relaxed">
                      {inline(cell, `t${key}-r${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^```/.test(line.trim())) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <pre
          key={`b${key++}`}
          className="my-3 rounded-lg border border-bordermuted bg-bg-tertiary p-3 overflow-x-auto text-[11px] font-mono leading-relaxed"
        >
          <code className="text-text-secondary">{buf.join('\n')}</code>
        </pre>
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const sizes = ['text-base', 'text-sm', 'text-[13px]', 'text-xs', 'text-xs', 'text-xs'];
      blocks.push(
        <div
          key={`b${key++}`}
          className={`mt-4 mb-2 font-semibold tracking-tight ${sizes[level - 1]} ${level === 1 ? 'text-text-primary text-base border-b border-bordermuted pb-1' : level === 2 ? 'text-text-primary' : 'text-text-primary/90'}`}
        >
          {inline(heading[2], `b${key}`)}
        </div>
      );
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      blocks.push(<hr key={`b${key++}`} className="my-3 border-bordermuted" />);
      i++;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const um = l.match(/^\s*[-*+]\s+(.*)$/);
        const om = l.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ordered && om) {
          items.push(om[1]);
        } else if (!ordered && um) {
          items.push(um[1]);
        } else if (l.trim() && /^\s{2,}\S/.test(l) && items.length) {
          items[items.length - 1] += ' ' + l.trim();
        } else {
          break;
        }
        i++;
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag
          key={`b${key++}`}
          className={`my-2 ml-5 space-y-1 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-text-disabled`}
        >
          {items.map((it, n) => (
            <li key={n} className="pl-1 leading-relaxed text-text-secondary">
              {inline(it, `b${key}-${n}`)}
            </li>
          ))}
        </Tag>
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote
          key={`b${key++}`}
          className="my-2 border-l-2 border-border pl-2.5 text-text-secondary"
        >
          {inline(buf.join(' '), `b${key}`)}
        </blockquote>
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const buf: string[] = [line];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim() || /^```/.test(l.trim()) || /^(#{1,6})\s+/.test(l) || /^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l) || /^\s*>\s?/.test(l)) {
        break;
      }
      buf.push(l);
      i++;
    }
    blocks.push(
      <p key={`b${key++}`} className="my-1.5 whitespace-pre-wrap break-words">
        {inline(buf.join('\n'), `b${key}`)}
      </p>
    );
  }

  return <div className="markdown text-sm leading-relaxed">{blocks}</div>;
}
