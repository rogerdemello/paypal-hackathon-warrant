import { categorize, mapAvailability } from './listing';
import { CatalogError, type Availability, type Catalog, type Product, type SearchOptions } from './types';

/**
 * Channel3 product search (https://docs.trychannel3.com). Endpoints used:
 *   POST /v1/search            { query, limit, filters: { price: { max_price } } }  ->  { products: [...], next_page_token }
 *   GET  /v1/products/{id}                                                          ->  one product
 * Auth: `x-api-key`. Prices are numbers of dollars (`offers[].price.amount`).
 *
 * The documented parts of the response are the product `id` and `title`, and per offer the retailer `domain`, `price`
 * (`amount`, `currency`), `availability` and `url`. Everything else (description, brand, images, category) is read
 * defensively under the names the product model uses; a missing field becomes an empty value, never an error.
 * [spike] Confirm the optional field names against a real response once an API key is available.
 */

export interface Channel3Config {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const asStr = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    const s = asStr(v);
    if (s !== null) return s;
  }
  return null;
}

function imageOf(raw: Rec): string | null {
  const direct = firstString(raw['image_url'], raw['image']);
  if (direct !== null) return direct;
  const images = raw['images'];
  if (Array.isArray(images) && images.length > 0) {
    const first: unknown = images[0];
    return typeof first === 'string' ? first : isRec(first) ? firstString(first['url'], first['src']) : null;
  }
  return null;
}

function brandOf(raw: Rec): string | null {
  const brand = raw['brand'];
  return firstString(raw['brand_name'], isRec(brand) ? brand['name'] : brand);
}

function categoryTextOf(raw: Rec): string | null {
  const categories = raw['categories'];
  if (Array.isArray(categories) && categories.length > 0) {
    const first: unknown = categories[0];
    return typeof first === 'string' ? first : isRec(first) ? firstString(first['name'], first['slug']) : null;
  }
  return firstString(raw['category']);
}

interface Offer {
  readonly domain: string;
  readonly url: string;
  readonly cents: number;
  readonly currency: string;
  readonly availability: Availability;
}

function offersOf(raw: Rec): Offer[] {
  const offers: Offer[] = [];
  for (const candidate of Array.isArray(raw['offers']) ? (raw['offers'] as unknown[]) : []) {
    if (!isRec(candidate)) continue;
    const price = isRec(candidate['price']) ? candidate['price'] : null;
    const raw = price === null ? null : price['amount'];
    const amount = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
    const domain = asStr(candidate['domain']);
    const url = asStr(candidate['url']);
    if (price === null || !Number.isFinite(amount) || amount <= 0 || domain === null || url === null) continue;
    offers.push({
      domain,
      url,
      cents: Math.round(amount * 100),
      currency: asStr(price['currency']) ?? 'USD',
      availability: mapAvailability(candidate['availability']),
    });
  }
  return offers;
}

/** Map one Channel3 product to a Warrant product using its best offer: the cheapest one that can be shipped now. */
export function mapChannel3Product(raw: unknown): Product | null {
  if (!isRec(raw)) return null;
  const id = asStr(raw['id']);
  const title = asStr(raw['title']);
  if (id === null || title === null) return null;
  const offers = offersOf(raw);
  const shippable = offers.filter((o) => o.availability !== 'out_of_stock');
  const pool = shippable.length > 0 ? shippable : offers;
  const best = [...pool].sort((a, b) => a.cents - b.cents)[0];
  if (best === undefined) return null;
  const description = firstString(raw['description']) ?? '';
  return {
    id,
    title,
    description,
    brand: brandOf(raw),
    category: categorize({ title, category: categoryTextOf(raw), description }),
    imageUrl: imageOf(raw),
    priceCents: best.cents,
    currency: best.currency,
    availability: best.availability,
    merchantDomain: best.domain,
    url: best.url,
    source: 'channel3',
  };
}

export class Channel3Catalog implements Catalog {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: Channel3Config) {
    if (config.apiKey.trim().length === 0) throw new CatalogError('a Channel3 API key is required');
    this.baseUrl = (config.baseUrl ?? 'https://api.trychannel3.com').replace(/\/+$/, '');
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const body: Rec = { query, limit: options.limit ?? 8 };
    if (options.maxPriceCents !== undefined) body['filters'] = { price: { max_price: options.maxPriceCents / 100 } };
    const json = await this.call('POST', '/v1/search', body);
    const items = isRec(json) && Array.isArray(json['products']) ? (json['products'] as unknown[]) : [];
    return items.map(mapChannel3Product).filter((p): p is Product => p !== null);
  }

  async get(id: string): Promise<Product | null> {
    try {
      return mapChannel3Product(await this.call('GET', `/v1/products/${encodeURIComponent(id)}`));
    } catch (error) {
      if (error instanceof CatalogError && error.status === 404) return null;
      throw error;
    }
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { 'x-api-key': this.config.apiKey, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new CatalogError(`Channel3 is unreachable: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    if (!response.ok) throw new CatalogError(`Channel3 returned HTTP ${response.status}`, response.status);
    try {
      return await response.json();
    } catch {
      throw new CatalogError('Channel3 returned a response that is not JSON', response.status);
    }
  }
}
