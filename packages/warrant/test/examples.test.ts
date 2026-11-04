import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { quickstart } from '../examples/quickstart';

describe('examples/quickstart.ts (embedded verbatim in packages/warrant/README.md)', () => {
  it('runs the whole flow: checkout accepted, payer bound, dispute fought', async () => {
    const out = await quickstart();
    expect(out.verification.outcome).toBe('ACCEPT');
    expect(out.verification.findings.every((f) => f.outcome === 'pass')).toBe(true);
    expect(out.payer.outcome).toBe('ACCEPT');
    expect(out.references).toEqual({ customId: 'wrt:crt_1', invoiceId: expect.stringMatching(/^WRT-[A-Za-z0-9_-]{16}$/) });
    expect(out.decision).toMatchObject({ outcome: 'FIGHT', action: { type: 'provide-evidence' }, attribution: { principal: 'primary' } });
    expect(out.packet).toMatchObject({ dispute_id: 'PP-D-1', signatures: { all_valid: true } });
  });

  it('the README shows exactly this file, so the documented code is the tested code', () => {
    const source = readFileSync(new URL('../examples/quickstart.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim();
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(readme, 'packages/warrant/README.md must embed examples/quickstart.ts verbatim').toContain(source);
  });
});
