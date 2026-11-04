#!/usr/bin/env node
// Checks that every relative link in the repository's Markdown files points at a file or directory that exists, and that
// every #anchor points at a heading in the target file. External links are not fetched (CI must not depend on the network).
//
//   node scripts/check-docs.mjs

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '_strategy', 'dist', 'coverage', 'test-results', 'playwright-report', '.data']);

function* markdownFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) yield* markdownFiles(path);
    else if (name.endsWith('.md')) yield path;
  }
}

/** GitHub's heading slug: lower case, punctuation dropped, spaces to hyphens. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

const anchorCache = new Map();
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  const seen = new Map();
  const anchors = new Set();
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const m of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(m[1]);
  anchorCache.set(file, anchors);
  return anchors;
}

const problems = [];
let links = 0;
for (const file of markdownFiles(root)) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ' ')).replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const m of line.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\bhref="([^"]+)"/g)) {
      const target = m[1] ?? m[2];
      if (target === undefined || /^(https?:|mailto:|tel:|data:)/i.test(target) || target.startsWith('<')) continue;
      links += 1;
      const [pathPart, anchor] = target.split('#');
      const targetFile = pathPart === '' ? file : resolve(dirname(file), decodeURIComponent(pathPart));
      const where = `${relative(root, file).split(sep).join('/')}:${index + 1}`;
      // _strategy/ is private and not in the repository, so links into it cannot resolve in a checkout.
      if (relative(root, targetFile).split(sep)[0] === '_strategy') continue;
      if (!existsSync(targetFile)) {
        problems.push(`${where}: "${target}" does not exist`);
        continue;
      }
      if (anchor !== undefined && anchor !== '' && statSync(targetFile).isFile() && targetFile.endsWith('.md')) {
        if (!anchorsOf(targetFile).has(anchor.toLowerCase())) problems.push(`${where}: "${target}" has no heading "#${anchor}"`);
      }
    }
  });
}

if (problems.length > 0) {
  console.error(`${problems.length} broken link${problems.length === 1 ? '' : 's'} in the documentation:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Documentation links ok (${links} relative links checked).`);
