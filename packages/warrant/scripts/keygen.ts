// Prints fresh Ed25519 private keys (base64 PKCS#8) as NAME=value lines on stdout, for pasting into .env.
// Usage: pnpm keygen        (pnpm -s keygen prints only the key lines)
// The private keys are secrets: keep them in an untracked .env or a secret manager, never in the repository.
import { generateKeyEnv } from '../src/keys';

const { privateLines, publicLines } = generateKeyEnv();

process.stdout.write(`${privateLines.join('\n')}\n`);
process.stderr.write(
  [
    '',
    'Above: new Ed25519 private keys. Paste them into .env. Keep them secret.',
    'Public keys (SPKI, base64) for the registry; safe to publish:',
    ...publicLines.map((line) => `  ${line}`),
    '',
  ].join('\n'),
);
