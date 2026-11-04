// Regenerates docs/test-vectors.json from the test fixtures. Deterministic: running it twice gives identical bytes.
// Usage: pnpm --filter @warrant/warrant vectors
import { writeFileSync } from 'node:fs';
import { serializeVectors } from '../test/vectors';

const target = new URL('../../../docs/test-vectors.json', import.meta.url);
const text = await serializeVectors();
writeFileSync(target, text, 'utf8');
process.stdout.write(`wrote ${text.length} bytes to docs/test-vectors.json\n`);
