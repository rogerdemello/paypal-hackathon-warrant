#!/usr/bin/env node
// A small, dependency-free scan for secrets that should never be committed. It is a safety net, not a replacement for a
// full scanner: it looks for private key blocks, API-key shapes this project uses, and values assigned to the secret
// settings in .env-style files that are not obviously placeholders.
//
//   node scripts/check-secrets.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '_strategy', 'dist', 'coverage', 'test-results', 'playwright-report', '.data']);
const BINARY = /\.(png|jpe?g|gif|ico|pdf|woff2?|ttf|zip|gz|tgz|lockb?)$/i;

function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out.split('\0').filter(Boolean).map((f) => join(root, f));
    if (files.length > 0) return files;
  } catch {
    // not a git checkout: walk the tree instead
  }
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(root);
  return files;
}

const SECRET_SETTINGS = ['PAYPAL_CLIENT_SECRET', 'PAYPAL_CLIENT_ID', 'PAYPAL_WEBHOOK_ID', 'ANTHROPIC_API_KEY', 'CHANNEL3_API_KEY', 'WALLET_SIGNING_KEY', 'AGENT_PLATFORM_SIGNING_KEY', 'REGISTRY_LOG_KEY', 'CONSOLE_TOKEN', 'PAYPAL_AUTH_ASSERTION_JWT'];
const PATTERNS = [
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'PayPal access token', re: /\bA21AA[A-Za-z0-9_-]{40,}/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];
const ASSIGNMENT = new RegExp(`^\\s*(?:export\\s+)?(${SECRET_SETTINGS.join('|')})[ \\t]*[=:][ \\t]*["']?([^\\s"'#]+)`, 'gm');
// Fixed, public test keys sign the vectors in docs/test-vectors.json, so the signed objects in it are not secrets.
const ALLOW_JWT = new Set(['docs/test-vectors.json']);
const PLACEHOLDER = /^(?:|\$\{.*\}|<.*>|xxx+|your[-_].*|changeme|example.*|test.*|dev.*|fixture.*|secret|sim.*|\.\.\.)$/i;

const problems = [];
const files = trackedFiles();

for (const file of files) {
  const rel = relative(root, file).split(sep).join('/');
  if (/^\.env(\..+)?$/.test(rel.split('/').pop() ?? '') && !rel.endsWith('.example')) {
    problems.push(`${rel}: an environment file with real values must not be committed`);
    continue;
  }
  if (BINARY.test(file) || !existsSync(file) || statSync(file).size > 2_000_000) continue;
  const text = readFileSync(file, 'utf8');
  for (const { name, re } of PATTERNS) {
    const m = re.exec(text);
    if (m !== null && !(name === 'JWT' && ALLOW_JWT.has(rel))) problems.push(`${rel}: looks like a ${name}`);
  }
  // Settings assigned in .env-style files, shell snippets and YAML. TypeScript and tests assign test values on purpose.
  if (/\.(env|example|ya?ml|sh|md)$/.test(rel) || rel.endsWith('.env.example')) {
    for (const m of text.matchAll(ASSIGNMENT)) {
      const value = m[2] ?? '';
      if (!PLACEHOLDER.test(value) && value.length >= 12) problems.push(`${rel}: ${m[1]} is set to a value that does not look like a placeholder`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Possible secrets found:\n  ${problems.join('\n  ')}\nIf one is a false positive, change the value to an obvious placeholder.`);
  process.exit(1);
}
console.log(`No secrets found in ${files.length} files.`);
