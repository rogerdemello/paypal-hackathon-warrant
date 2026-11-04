import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, HASH_PATTERN, canonicalize, hashBytes, hashJson, hashText, isHash, sha256Hex } from '../src/canonical';

// Non-ASCII characters are built from code points on purpose, so no editor or tool can re-encode them.
const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

describe('canonicalize (RFC 8785)', () => {
  it('sorts object keys by UTF-16 code unit order (RFC 8785 section 3.2.3)', () => {
    const euro = cp(0x20ac);
    const control = cp(0x80);
    const oDiaeresis = cp(0xf6);
    const hebrewDaletDagesh = cp(0xfb33);
    const grinningFace = cp(0x1f600); // surrogate pair d83d de00: sorts BEFORE U+FB33 in UTF-16 order
    const input: Record<string, string> = {
      [euro]: 'Euro Sign',
      '\r': 'Carriage Return',
      [hebrewDaletDagesh]: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      [grinningFace]: 'Emoji: Grinning Face',
      [control]: 'Control',
      [oDiaeresis]: 'Latin Small Letter O With Diaeresis',
    };
    const text = canonicalize(input);
    // JSON.parse + Object.keys would reorder the integer-like key "1", so read the keys from the text itself.
    const keys = [...text.matchAll(/"((?:[^"\\]|\\.)*)":"/g)].map((m) => JSON.parse(`"${m[1] ?? ''}"`) as string);
    expect(keys).toEqual(['\r', '1', control, oDiaeresis, euro, grinningFace, hebrewDaletDagesh]);
  });

  it('reproduces the RFC 8785 section 3.2.4 example byte for byte', () => {
    // RFC input string: euro $ U+000F U+000A A ' B " \ \ " /   (every character decoded to its code point)
    const string = cp(0x20ac, 0x24, 0x0f, 0x0a, 0x41, 0x27, 0x42, 0x22, 0x5c, 0x5c, 0x22, 0x2f);
    const input = {
      // eslint-disable-next-line no-loss-of-precision -- the RFC's own literal
      numbers: [333333333.33333329, 1e30, 4.5, 0.002, 1e-27],
      string,
      literals: [null, true, false],
    };
    // RFC output, verbatim (the euro sign is the literal character, U+000F is escaped as \u000f).
    const expected =
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"` +
      cp(0x20ac) +
      String.raw`$\u000f\nA'B\"\\\\\"/"}`;
    expect(canonicalize(input)).toBe(expected);
  });

  it.each([
    [0, '0'],
    [-0, '0'],
    [1, '1'],
    [-1, '-1'],
    [1.5, '1.5'],
    [4.5, '4.5'],
    [0.002, '0.002'],
    [1e21, '1e+21'],
    [1e-7, '1e-7'],
    [123456789012345680000, '123456789012345680000'],
    [9007199254740991, '9007199254740991'],
    [5e-324, '5e-324'],
    [1.7976931348623157e308, '1.7976931348623157e+308'],
  ])('serializes the number %s as %s (ECMAScript Number-to-String, RFC 8785 section 3.2.2.3)', (n, text) => {
    expect(canonicalize(n)).toBe(text);
  });

  it('emits minimal escapes and no insignificant whitespace', () => {
    const unescaped = cp(0x7f, 0x2028); // DEL and LINE SEPARATOR are not escaped by JCS
    const input = { b: [1, 2, { d: 'x', c: null }], a: 'q"\\\b\f\n\r\t' + cp(0x01, 0x1f) + unescaped };
    expect(canonicalize(input)).toBe(
      String.raw`{"a":"q\"\\\b\f\n\r\t\u0001\u001f` + unescaped + String.raw`","b":[1,2,{"c":null,"d":"x"}]}`,
    );
  });

  it('serializes scalars, empties and nesting', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize('')).toBe('""');
    expect(canonicalize([])).toBe('[]');
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([[[]], {}])).toBe('[[[]],{}]');
  });

  it('omits object properties whose value is undefined, so a JSON round trip cannot change the hash', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('is insensitive to property insertion order', () => {
    expect(canonicalize({ a: 1, b: 2, c: { x: 1, y: 2 } })).toBe(canonicalize({ c: { y: 2, x: 1 }, b: 2, a: 1 }));
  });

  it('handles an own property called __proto__ as ordinary data', () => {
    const parsed = JSON.parse('{"__proto__":{"admin":true},"a":1}') as unknown;
    expect(canonicalize(parsed)).toBe('{"__proto__":{"admin":true},"a":1}');
  });

  it('accepts objects with a null prototype', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare['k'] = 1;
    expect(canonicalize(bare)).toBe('{"k":1}');
  });

  const lone = String.fromCharCode(0xd800);
  const loneLow = String.fromCharCode(0xdc00);
  const sparse: unknown[] = [1];
  sparse[2] = 3;
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['undefined', undefined],
    ['a bigint', 10n],
    ['a symbol', Symbol('x')],
    ['a function', () => 1],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a Set', new Set()],
    ['a class instance', new (class Foo {})()],
    ['an object with a symbol key', { [Symbol('s')]: 1 }],
    ['a lone high surrogate', lone],
    ['a lone low surrogate', `x${loneLow}y`],
    ['an array with undefined', [1, undefined]],
    ['a sparse array', sparse],
    ['a lone-surrogate key', { [lone]: 1 }],
  ])('rejects %s', (_name, value) => {
    expect(() => canonicalize(value)).toThrow(CanonicalJsonError);
  });

  it('rejects cyclic structures', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(() => canonicalize(a)).toThrow(CanonicalJsonError);
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => canonicalize(arr)).toThrow(CanonicalJsonError);
  });

  it('accepts shared (non-cyclic) references', () => {
    const shared = { x: 1 };
    expect(canonicalize({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it('rejects absurd nesting instead of overflowing the stack', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 5000; i++) deep = [deep];
    expect(() => canonicalize(deep)).toThrow(CanonicalJsonError);
  });

  it('property: canonical output is valid JSON and idempotent', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const once = canonicalize(value);
        const reparsed = JSON.parse(once) as unknown;
        expect(canonicalize(reparsed)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it('property: output ignores property insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer(), { maxKeys: 8 }), fc.nat(), (dict, seed) => {
        const entries = Object.entries(dict);
        const pivot = seed % (entries.length || 1);
        const rotated = entries.slice(pivot).concat(entries.slice(0, pivot));
        expect(canonicalize(Object.fromEntries(rotated))).toBe(canonicalize(dict));
      }),
    );
  });
});

describe('hashes', () => {
  it('matches known SHA-256 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes UTF-8 bytes', () => {
    const euro = cp(0x20ac);
    expect(sha256Hex(euro)).toBe('c4cc90ed3d26f12d4b08a75140970a7904035c31cbb4515a83f19b9003c00d1d');
    expect(sha256Hex(new TextEncoder().encode(euro))).toBe(sha256Hex(euro));
  });

  it('formats hashes as sha256: plus unpadded base64url (the Warrant wire format)', () => {
    expect(hashBytes('abc')).toBe('sha256:ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
    expect(hashText('')).toBe('sha256:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
    expect(hashBytes(new TextEncoder().encode('abc'))).toBe(hashBytes('abc'));
    expect(hashBytes('abc')).toMatch(HASH_PATTERN);
  });

  it('hashJson is SHA-256 over the canonical form, independent of key order', () => {
    expect(hashJson({ b: 1, a: [true, null] })).toBe(hashBytes('{"a":[true,null],"b":1}'));
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
  });

  it('isHash accepts only the exact format', () => {
    expect(isHash(hashText('x'))).toBe(true);
    for (const bad of ['', 'sha256:', 'sha256:abc', 'sha256:' + 'A'.repeat(42), 'sha256:' + 'A'.repeat(44), 'sha256:' + 'A'.repeat(42) + '=', 'SHA256:' + 'A'.repeat(43), 'sha1:' + 'A'.repeat(43), ' sha256:' + 'A'.repeat(43), 'sha256:' + '+'.repeat(43)]) {
      expect(isHash(bad)).toBe(false);
    }
    expect(isHash(5)).toBe(false);
  });
});
