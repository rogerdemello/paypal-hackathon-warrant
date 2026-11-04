import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_CENTS,
  MoneyError,
  addCents,
  formatMoney,
  isCents,
  mulCents,
  parseMoney,
  subCents,
  sumCents,
  tryParseMoney,
} from '../src/money';

describe('parseMoney', () => {
  it.each([
    ['0', 0],
    ['0.00', 0],
    ['0.5', 50],
    ['0.05', 5],
    ['1', 100],
    ['89', 8900],
    ['89.0', 8900],
    ['89.00', 8900],
    ['89.99', 8999],
    ['300.00', 30000],
    ['120.00', 12000],
    ['1000000.01', 100000001],
  ])('parses %s as %i cents', (input, cents) => {
    expect(parseMoney(input)).toBe(cents);
  });

  it.each([
    '',
    ' ',
    ' 1.00',
    '1.00 ',
    '1.',
    '.5',
    '-1.00',
    '+1.00',
    '1.005',
    '1.000',
    '1,000.00',
    '1e3',
    '1E3',
    '0x10',
    '01.00',
    '00',
    'NaN',
    'Infinity',
    '1.0.0',
    '$1.00',
    '1.00 USD',
    '١٢٣', // Arabic-Indic digits
    '1\n',
    '\u00001',
  ])('rejects %j', (input) => {
    expect(() => parseMoney(input)).toThrow(MoneyError);
    expect(tryParseMoney(input)).toBeNull();
  });

  it('rejects non-string input at runtime', () => {
    expect(() => parseMoney(12 as unknown as string)).toThrow(MoneyError);
    expect(tryParseMoney(null as unknown as string)).toBeNull();
  });

  it('rejects values above the safe-integer cents range', () => {
    expect(() => parseMoney('90071992547409.92')).toThrow(MoneyError);
    expect(() => parseMoney('99999999999999999999.99')).toThrow(MoneyError);
    expect(parseMoney('90071992547409.91')).toBe(MAX_CENTS);
  });

  it('property: formatMoney(parseMoney(s)) is the canonical form of s', () => {
    const decimal = fc
      .tuple(fc.bigInt({ min: 0n, max: 900_000_000_000n }), fc.option(fc.integer({ min: 0, max: 99 }), { nil: undefined }))
      .map(([whole, frac]) => (frac === undefined ? `${whole}` : `${whole}.${String(frac).padStart(2, '0')}`));
    fc.assert(
      fc.property(decimal, (s) => {
        const cents = parseMoney(s);
        const canonical = formatMoney(cents);
        expect(parseMoney(canonical)).toBe(cents);
        expect(canonical).toMatch(/^(0|[1-9]\d*)\.\d{2}$/);
      }),
    );
  });
});

describe('formatMoney', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [50, '0.50'],
    [8999, '89.99'],
    [30000, '300.00'],
    [-5, '-0.05'],
    [-12345, '-123.45'],
  ])('formats %i cents as %s', (cents, text) => {
    expect(formatMoney(cents)).toBe(text);
  });

  it('rejects non-integer and unsafe values', () => {
    expect(() => formatMoney(1.5)).toThrow(MoneyError);
    expect(() => formatMoney(Number.NaN)).toThrow(MoneyError);
    expect(() => formatMoney(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
  });

  it('property: parse(format(c)) === c for every non-negative safe cents value', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_CENTS }), (c) => {
        expect(parseMoney(formatMoney(c))).toBe(c);
      }),
    );
  });
});

describe('integer cents arithmetic', () => {
  it('isCents accepts only safe integers', () => {
    expect(isCents(0)).toBe(true);
    expect(isCents(-5)).toBe(true);
    expect(isCents(1.5)).toBe(false);
    expect(isCents(Number.NaN)).toBe(false);
    expect(isCents(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isCents(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isCents('5')).toBe(false);
  });

  it('adds, subtracts, multiplies and sums exactly', () => {
    expect(addCents(1999, 1)).toBe(2000);
    expect(subCents(2000, 1)).toBe(1999);
    expect(subCents(1, 2)).toBe(-1);
    expect(mulCents(1999, 3)).toBe(5997);
    expect(sumCents([100, 200, 300])).toBe(600);
    expect(sumCents([])).toBe(0);
  });

  it('refuses to produce values that are not safe integers', () => {
    expect(() => addCents(MAX_CENTS, 1)).toThrow(MoneyError);
    expect(() => subCents(-MAX_CENTS, 1)).toThrow(MoneyError);
    expect(() => mulCents(MAX_CENTS, 2)).toThrow(MoneyError);
    expect(() => sumCents([MAX_CENTS, 1])).toThrow(MoneyError);
    expect(() => addCents(0.5, 1)).toThrow(MoneyError);
    expect(() => mulCents(100, 1.5)).toThrow(MoneyError);
    expect(() => mulCents(100, Number.NaN)).toThrow(MoneyError);
  });

  it('property: addition commutes and subtraction inverts it within range', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e12 }), fc.integer({ min: 0, max: 1e12 }), (a, b) => {
        expect(addCents(a, b)).toBe(addCents(b, a));
        expect(subCents(addCents(a, b), b)).toBe(a);
      }),
    );
  });
});
