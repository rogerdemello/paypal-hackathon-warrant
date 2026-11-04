import { describe, expect, it } from 'vitest';
import { CatalogError, Channel3Catalog, FIXTURE_PRODUCTS, FixtureCatalog, RISKY_CATEGORIES, budgetFromText, categorize, isAvailable, listingHash, listingSnapshot, mapAvailability, mapChannel3Product, tokenize } from '../src';

describe('fixtures', () => {
  const catalog = new FixtureCatalog();

  it('has unique ids, integer cents and a consistent shape', () => {
    const ids = FIXTURE_PRODUCTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of FIXTURE_PRODUCTS) {
      expect(Number.isInteger(p.priceCents) && p.priceCents > 0).toBe(true);
      expect(p.currency).toBe('USD');
      expect(p.source).toBe('fixture');
      expect(p.url).toContain(p.merchantDomain);
    }
  });

  it('finds the demo item for the headline request and respects the budget in the text', async () => {
    const results = await catalog.search('Find a standing desk converter under $120');
    expect(results[0]?.id).toBe('fx_desk_conv_32');
    expect(results.every((p) => p.priceCents <= 12_000)).toBe(true);
    expect(results.map((p) => p.id)).toContain('fx_desk_conv_36');
    expect(results.map((p) => p.id)).not.toContain('fx_desk_conv_42');
  });

  it('an explicit maximum price overrides the text, and the limit caps the list', async () => {
    const cheap = await catalog.search('standing desk converter', { maxPriceCents: 9000 });
    expect(cheap.map((p) => p.id).slice(0, 1)).toEqual(['fx_desk_conv_32']);
    expect(cheap.map((p) => p.id)).toContain('fx_desk_conv_oos');
    expect(cheap.every((p) => p.priceCents <= 9000)).toBe(true);
    expect(await catalog.search('desk', { limit: 2 })).toHaveLength(2);
  });

  it('returns nothing for an empty or stopword-only query, and nothing that matches nothing', async () => {
    expect(await catalog.search('')).toEqual([]);
    expect(await catalog.search('find me a the under $50')).toEqual([]);
    expect(await catalog.search('zzzzqqq')).toEqual([]);
  });

  it('lists what can be shipped now before unavailable listings, which come last', async () => {
    const results = await catalog.search('standing desk converter', { limit: 50 });
    const firstUnavailable = results.findIndex((p) => !isAvailable(p));
    expect(firstUnavailable).toBeGreaterThan(0);
    expect(results.slice(firstUnavailable).every((p) => !isAvailable(p))).toBe(true);
  });

  it('is deterministic and ranks title matches above description matches', async () => {
    const a = await catalog.search('ergonomic');
    const b = await catalog.search('ergonomic');
    expect(a).toEqual(b);
    expect(a[0]?.title.toLowerCase()).toContain('ergonomic');
  });

  it('gets a product by id, or null', async () => {
    expect((await catalog.get('fx_chair'))?.title).toContain('Chair');
    expect(await catalog.get('nope')).toBeNull();
  });

  it('the hostile listings exist, are categorised, and carry instructions aimed at an agent', async () => {
    const organizer = await catalog.get('fx_inject_organizer');
    expect(organizer?.description).toMatch(/ignore all previous instructions/i);
    const gift = await catalog.get('fx_giftcard_visa');
    expect(gift?.category).toBe('gift_cards');
    for (const id of ['fx_giftcard_store', 'fx_prepaid', 'fx_crypto', 'fx_casino']) {
      expect(RISKY_CATEGORIES).toContain((await catalog.get(id))?.category);
    }
  });

  it('marks the out-of-stock listing as unavailable', async () => {
    const oos = await catalog.get('fx_desk_conv_oos');
    expect(oos?.availability).toBe('out_of_stock');
    expect(isAvailable(oos ?? FIXTURE_PRODUCTS[0]!)).toBe(false);
    expect(isAvailable(FIXTURE_PRODUCTS[0]!)).toBe(true);
  });
});

describe('helpers', () => {
  it('tokenizes into lower-case content words', () => {
    expect(tokenize('Find me the Standing Desk Converters under $120')).toEqual(['standing', 'desk', 'converter']);
    expect(tokenize('USB-C hub 7-in-1')).toEqual(['usb-c', 'hub', '7-in-1']);
  });

  it('reads a budget in dollars from free text', () => {
    expect(budgetFromText('under $120')).toBe(12_000);
    expect(budgetFromText('about $89.99 max')).toBe(8_999);
    expect(budgetFromText('120 dollars')).toBe(12_000);
    expect(budgetFromText('no budget here')).toBeNull();
  });

  it('categorizes risky listings first and is conservative about descriptions', () => {
    expect(categorize({ title: 'Visa Gift Card $50' })).toBe('gift_cards');
    expect(categorize({ title: 'Office Supplies Bundle', category: 'Gift Cards' })).toBe('gift_cards');
    expect(categorize({ title: 'Prepaid Debit Card Reload' })).toBe('prepaid_cards');
    expect(categorize({ title: 'Bitcoin Voucher' })).toBe('crypto');
    expect(categorize({ title: 'Casino Credit Pack' })).toBe('gambling');
    expect(categorize({ title: 'Standing Desk Converter' })).toBe('office_furniture');
    expect(categorize({ title: 'Wireless Mouse' })).toBe('electronics');
    expect(categorize({ title: 'A Novel' })).toBe('books');
    expect(categorize({ title: 'Coffee Grinder' })).toBe('kitchen');
    expect(categorize({ title: 'Throw Blanket' })).toBe('home');
    expect(categorize({ title: 'Mystery Item' })).toBe('other');
    // A risky word deep in a long description does not move an ordinary product.
    expect(categorize({ title: 'Mystery Item', description: `${'x '.repeat(300)} gift card` })).toBe('other');
    // But an early mention in the description of an otherwise unclassified item does.
    expect(categorize({ title: 'Mystery Item', description: 'Works like a gift card' })).toBe('gift_cards');
  });

  it('maps Channel3 availability strings, treating anything unknown as not shippable', () => {
    expect(mapAvailability('InStock')).toBe('in_stock');
    expect(mapAvailability('LimitedAvailability')).toBe('limited');
    for (const v of ['SoldOut', 'OutOfStock', 'PreOrder', 'BackOrder', 'whatever', undefined, 7]) expect(mapAvailability(v)).toBe('out_of_stock');
  });
});

describe('listing hash', () => {
  const base = FIXTURE_PRODUCTS[0]!;

  it('is a sha256 hash of the snapshot and is stable', () => {
    expect(listingHash(base)).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect(listingHash({ ...base })).toBe(listingHash(base));
  });

  it('changes with anything a buyer relies on, but not with the image', () => {
    const baseline = listingHash(base);
    for (const edit of [{ priceCents: base.priceCents + 1 }, { title: `${base.title}!` }, { description: `${base.description} New.` }, { availability: 'limited' as const }, { merchantDomain: 'other.example' }, { url: `${base.url}?x=1` }]) {
      expect(listingHash({ ...base, ...edit })).not.toBe(baseline);
    }
    expect(listingHash({ ...base, imageUrl: 'https://img.example/a.png' })).toBe(baseline);
    expect(Object.keys(listingSnapshot(base))).not.toContain('imageUrl');
  });
});

const sampleSearch = {
  products: [
    {
      id: '2yh8WH5',
      title: "Nike Air Force 1 '07",
      description: 'Classic leather sneaker.',
      brand_name: 'Nike',
      images: [{ url: 'https://img.example/af1.png' }],
      categories: [{ name: 'Shoes' }],
      offers: [
        { domain: 'nike.com', price: { amount: 110, currency: 'USD' }, availability: 'InStock', url: 'https://www.buy.trychannel3.com/a' },
        { domain: 'cheapshoes.example', price: { amount: 99.99, currency: 'USD' }, availability: 'InStock', url: 'https://www.buy.trychannel3.com/b' },
        { domain: 'soldout.example', price: { amount: 49.0, currency: 'USD' }, availability: 'SoldOut', url: 'https://www.buy.trychannel3.com/c' },
      ],
    },
    { id: 'no-offers', title: 'Broken', offers: [] },
    'not an object',
    { title: 'no id', offers: [{ domain: 'x', price: { amount: 1, currency: 'USD' }, availability: 'InStock', url: 'u' }] },
  ],
  next_page_token: 'abc',
};

describe('Channel3 mapping', () => {
  it('uses the cheapest offer that can be shipped now', () => {
    const product = mapChannel3Product(sampleSearch.products[0]);
    expect(product).toMatchObject({
      id: '2yh8WH5',
      title: "Nike Air Force 1 '07",
      brand: 'Nike',
      imageUrl: 'https://img.example/af1.png',
      priceCents: 9999,
      currency: 'USD',
      availability: 'in_stock',
      merchantDomain: 'cheapshoes.example',
      source: 'channel3',
    });
  });

  it('falls back to a sold-out offer (marked unavailable) when nothing can be shipped', () => {
    const product = mapChannel3Product({ id: 'x', title: 'T', offers: [{ domain: 'a', price: { amount: 5, currency: 'USD' }, availability: 'SoldOut', url: 'u' }] });
    expect(product).toMatchObject({ availability: 'out_of_stock', priceCents: 500 });
  });

  it('rounds dollar amounts to cents and rejects negative, missing or non-numeric prices', () => {
    const offer = (amount: unknown) => ({ id: 'x', title: 'T', offers: [{ domain: 'a', price: { amount, currency: 'USD' }, availability: 'InStock', url: 'u' }] });
    expect(mapChannel3Product(offer(19.999))?.priceCents).toBe(2000);
    expect(mapChannel3Product(offer(0.1 + 0.2))?.priceCents).toBe(30);
    for (const bad of [-1, 0, '', 'abc', null, undefined, Number.NaN]) expect(mapChannel3Product(offer(bad))).toBeNull();
  });

  it('reads the optional fields under alternative names and survives their absence', () => {
    const product = mapChannel3Product({ id: 'x', title: 'Plain', brand: { name: 'B' }, image_url: 'https://i/x.png', category: 'Books', offers: [{ domain: 'a', price: { amount: 1, currency: 'USD' }, availability: 'InStock', url: 'u' }] });
    expect(product).toMatchObject({ brand: 'B', imageUrl: 'https://i/x.png', category: 'books', description: '' });
    const bare = mapChannel3Product({ id: 'y', title: 'Bare', images: ['https://i/y.png'], categories: ['Gift Cards'], offers: [{ domain: 'a', price: { amount: 1 }, availability: 'LimitedAvailability', url: 'u' }] });
    expect(bare).toMatchObject({ imageUrl: 'https://i/y.png', category: 'gift_cards', currency: 'USD', availability: 'limited' });
  });
});

const urlOf = (input: string | URL | Request): string => (typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
const bodyOf = (init: RequestInit | undefined): string => (typeof init?.body === 'string' ? init.body : '');

describe('Channel3Catalog', () => {
  const respond = (status: number, body: unknown) => () => Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

  it('requires an API key', () => {
    expect(() => new Channel3Catalog({ apiKey: '  ' })).toThrow(CatalogError);
  });

  it('posts the search with the key and a dollar price filter, and maps the products it can', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const catalog = new Channel3Catalog({
      apiKey: 'k_test',
      baseUrl: 'https://api.example/',
      fetch: (input, init) => {
        seen.push({ url: urlOf(input), init });
        return respond(200, sampleSearch)();
      },
    });
    const products = await catalog.search('sneakers', { maxPriceCents: 12_000, limit: 3 });
    expect(products.map((p) => p.id)).toEqual(['2yh8WH5']);
    expect(seen[0]?.url).toBe('https://api.example/v1/search');
    expect(seen[0]?.init?.method).toBe('POST');
    expect((seen[0]?.init?.headers as Record<string, string>)['x-api-key']).toBe('k_test');
    expect(JSON.parse(bodyOf(seen[0]?.init))).toEqual({ query: 'sneakers', limit: 3, filters: { price: { max_price: 120 } } });
  });

  it('omits the price filter when there is no maximum', async () => {
    let body = '';
    const catalog = new Channel3Catalog({ apiKey: 'k', fetch: (_i, init) => ((body = bodyOf(init)), respond(200, { products: [] })()) });
    expect(await catalog.search('x')).toEqual([]);
    expect(JSON.parse(body)).toEqual({ query: 'x', limit: 8 });
  });

  it('gets a product, returns null for 404, and throws for other failures', async () => {
    const ok = new Channel3Catalog({ apiKey: 'k', fetch: respond(200, sampleSearch.products[0]) });
    expect((await ok.get('2yh8WH5'))?.id).toBe('2yh8WH5');
    const missing = new Channel3Catalog({ apiKey: 'k', fetch: respond(404, { error: 'nope' }) });
    expect(await missing.get('x')).toBeNull();
    const broken = new Channel3Catalog({ apiKey: 'k', fetch: respond(500, 'boom') });
    await expect(broken.get('x')).rejects.toMatchObject({ name: 'CatalogError', status: 500 });
  });

  it('turns HTTP errors, network errors and non-JSON bodies into CatalogError', async () => {
    await expect(new Channel3Catalog({ apiKey: 'k', fetch: respond(401, 'no') }).search('x')).rejects.toMatchObject({ status: 401 });
    await expect(new Channel3Catalog({ apiKey: 'k', fetch: () => Promise.reject(new Error('dns')) }).search('x')).rejects.toThrow(/unreachable: dns/);
    await expect(new Channel3Catalog({ apiKey: 'k', fetch: respond(200, 'not json') }).search('x')).rejects.toThrow(/not JSON/);
    await expect(new Channel3Catalog({ apiKey: 'k', // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case under test
      fetch: () => Promise.reject('weird') }).search('x')).rejects.toThrow(/unknown error/);
  });

  it('treats a response without a products array as no results', async () => {
    expect(await new Channel3Catalog({ apiKey: 'k', fetch: respond(200, { something: 1 }) }).search('x')).toEqual([]);
    expect(await new Channel3Catalog({ apiKey: 'k', fetch: respond(200, []) }).search('x')).toEqual([]);
  });
});
