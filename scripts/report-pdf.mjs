#!/usr/bin/env node
// Turns a Markdown report into a client-ready PDF: a styled HTML page printed by headless Google Chrome.
//
//   node scripts/report-pdf.mjs <report.md> <report.pdf> [--title "Weekly FinOps report"] [--subtitle "11–17 Oct 2026"]
//
// Handles the Markdown the reports use: headings, paragraphs, bold / italic / code / links, lists (nested),
// tables, block quotes, code blocks and rules. No dependencies; needs Chrome (or Chromium / Edge / Brave), or
// CHROME_PATH pointing at one.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const BROWSERS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

// ---- Markdown -> HTML (the subset the reports use) ----

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function inline(text) {
  // Code spans first, kept out of the other rules.
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+|[^)\s]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

export function markdownToHtml(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l ?? '');
  const isBlockStart = (l) =>
    /^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+[.)])\s+|\s*(-{3,}|\*{3,}|_{3,})\s*$)/.test(l) || (l.includes('|') && isTableSep(lines[i + 1]));

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // Fenced code
    if (/^```/.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    // Heading
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    // Rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    // Table
    if (line.includes('|') && isTableSep(lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : 'left'));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      const td = (tag, c, j) => `<${tag}${align[j] && align[j] !== 'left' ? ` style="text-align:${align[j]}"` : ''}>${inline(c)}</${tag}>`;
      out.push(
        `<table><thead><tr>${head.map((c, j) => td('th', c, j)).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${head.map((_, j) => td('td', r[j] ?? '', j)).join('')}</tr>`).join('') +
          '</tbody></table>',
      );
      continue;
    }
    // Block quote
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdownToHtml(body.join('\n'))}</blockquote>`);
      continue;
    }
    // Lists (nested by indentation)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const items = [];
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
        else items[items.length - 1].text += ` ${lines[i].trim()}`;
        i++;
      }
      out.push(renderList(items));
      continue;
    }
    // Paragraph
    const para = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i]))) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

function renderList(items) {
  let html = '';
  const stack = [];
  for (const it of items) {
    while (stack.length && it.indent < stack.at(-1).indent) html += `</li></${stack.pop().tag}>`;
    if (!stack.length || it.indent > stack.at(-1).indent) {
      const tag = it.ordered ? 'ol' : 'ul';
      stack.push({ indent: it.indent, tag });
      html += `<${tag}>`;
    } else html += '</li>';
    html += `<li>${inline(it.text)}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

// ---- page ----

function page({ body, title, subtitle, generated }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm 18mm; }
  :root { --ink: #1d2433; --muted: #5d6779; --line: #dde2ea; --accent: #1f5fbf; --soft: #f4f6fa; }
  * { box-sizing: border-box; }
  body { font: 10pt/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: var(--ink); margin: 0; }
  header.cover { border-bottom: 3px solid var(--accent); padding-bottom: 10px; margin-bottom: 18px; }
  header.cover .title { font-size: 20pt; font-weight: 700; margin: 0; }
  header.cover .subtitle { font-size: 11.5pt; color: var(--muted); margin-top: 2px; }
  header.cover .meta { font-size: 8.5pt; color: var(--muted); margin-top: 6px; }
  h1 { font-size: 15pt; margin: 18px 0 8px; }
  h2 { font-size: 13pt; margin: 20px 0 8px; padding-bottom: 3px; border-bottom: 1px solid var(--line); color: var(--accent); break-after: avoid; }
  h3 { font-size: 11pt; margin: 14px 0 6px; break-after: avoid; }
  h4, h5, h6 { font-size: 10pt; margin: 10px 0 4px; break-after: avoid; }
  p { margin: 6px 0; }
  ul, ol { margin: 4px 0 8px; padding-left: 18px; }
  li { margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 12px; font-size: 8.8pt; break-inside: auto; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th { background: var(--soft); text-align: left; font-weight: 600; }
  th, td { border: 1px solid var(--line); padding: 4px 6px; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #fbfcfe; }
  code { font: 8.5pt ui-monospace, Menlo, Consolas, monospace; background: var(--soft); padding: 0 3px; border-radius: 3px; word-break: break-all; }
  pre { background: var(--soft); padding: 8px; border-radius: 4px; white-space: pre-wrap; font-size: 8.5pt; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 8px 0; padding: 6px 10px; border-left: 3px solid var(--accent); background: var(--soft); color: var(--muted); }
  hr { border: 0; border-top: 1px solid var(--line); margin: 14px 0; }
  a { color: var(--accent); text-decoration: none; }
  strong { font-weight: 650; }
</style></head>
<body>
<header class="cover">
  <p class="title">${esc(title)}</p>
  ${subtitle ? `<div class="subtitle">${esc(subtitle)}</div>` : ''}
  <div class="meta">Generated ${esc(generated)}</div>
</header>
${body}
</body></html>`;
}

export function renderPdf({ input, output, title, subtitle }) {
  const md = readFileSync(input, 'utf8');
  // A leading "# Title" is replaced by the cover title block (--title, or that heading when none is given).
  const first = /^\s*#\s+(.+)\n/.exec(md);
  const docTitle = title ?? first?.[1]?.trim() ?? 'Report';
  const body = markdownToHtml(first ? md.slice(first[0].length) : md);
  const generated = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short' }).format(new Date());
  const browser = BROWSERS.find((p) => existsSync(p));
  if (!browser) throw new Error('No Chrome, Chromium, Edge or Brave found; set CHROME_PATH.');

  const dir = mkdtempSync(join(tmpdir(), 'report-pdf-'));
  try {
    const html = join(dir, 'report.html');
    writeFileSync(html, page({ body, title: docTitle, subtitle, generated }));
    execFileSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${join(dir, 'profile')}`, // never touches the user's own Chrome profile
        '--no-pdf-header-footer',
        `--print-to-pdf=${resolve(output)}`,
        pathToFileURL(html).href,
      ],
      { stdio: 'ignore', timeout: 120_000 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!existsSync(output) || statSync(output).size < 1000) throw new Error(`Chrome did not write ${output}`);
  return { output: resolve(output), bytes: statSync(output).size, title: docTitle };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { title: { type: 'string' }, subtitle: { type: 'string' } },
  });
  if (positionals.length !== 2) {
    console.error('Usage: node scripts/report-pdf.mjs <report.md> <report.pdf> [--title "..."] [--subtitle "..."]');
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(renderPdf({ input: positionals[0], output: positionals[1], ...values })));
  } catch (err) {
    console.error(`report-pdf: ${err.message}`);
    process.exit(1);
  }
}
