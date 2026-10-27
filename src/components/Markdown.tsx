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
        <code key={key} className="px-1 py-0.5 rounded bg-black/40 text-[0.92em] font-mono text-accent-cyan">
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
          className="text-accent-cyan underline decoration-dotted"
        >
          {mm?.[1]}
        </a>
      );
    } else {
      nodes.push(
        <em key={key} className="italic">
          {tok.slice(1, -1)}
        </em>
      );
    }
    last = idx + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export default function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

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
          className="my-2 rounded border border-border bg-black/60 p-2 overflow-x-auto text-[11px] font-mono leading-relaxed"
        >
          <code>{buf.join('\n')}</code>
        </pre>
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const sizes = ['text-base', 'text-sm', 'text-sm', 'text-xs', 'text-xs', 'text-xs'];
      blocks.push(
        <div
          key={`b${key++}`}
          className={`mt-3 mb-1 font-semibold ${sizes[level - 1]} ${level <= 2 ? 'text-text-primary' : 'text-text-secondary'}`}
        >
          {inline(heading[2], `b${key}`)}
        </div>
      );
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      blocks.push(<hr key={`b${key++}`} className="my-3 border-border" />);
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
          className={`my-1.5 ml-4 space-y-0.5 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-text-secondary`}
        >
          {items.map((it, n) => (
            <li key={n}>{inline(it, `b${key}-${n}`)}</li>
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
          className="my-2 border-l-2 border-accent-cyan/40 pl-2 text-text-secondary"
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
