import { FIXTURE_PRODUCTS, isAvailable, listingHash, listingSnapshot, type Product } from '@warrant/catalog';
import type { CatalogLookup, CatalogOffer, MerchantMode } from '@warrant/warrant';
import { nowSeconds, type Clock } from '../clock';
import { json, maybeOne, type Db, type Queryable } from '../db';

/**
 * The demo merchant's own catalog and settings. The verifier prices every cart from here (V08), never from the cart: a
 * product the agent found on Channel3 is "listed" in the store at the retailer's price, and the merchant can change or
 * withdraw it afterwards.
 */

export interface StoreProduct {
  readonly sku: string;
  readonly title: string;
  readonly description: string;
  readonly brand: string | null;
  readonly category: string;
  readonly imageUrl: string | null;
  readonly priceCents: number;
  readonly currency: string;
  readonly available: boolean;
  readonly merchantDomain: string;
  readonly url: string;
  readonly source: string;
  /** Hash of the listing as it stands now. A cart line must carry this exact hash to pass V08. */
  readonly listingHash: string;
  readonly updatedAt: number;
}

interface ProductRow {
  sku: string;
  title: string;
  description: string;
  brand: string | null;
  category: string;
  image_url: string | null;
  price_cents: number;
  currency: string;
  available: boolean;
  merchant_domain: string;
  url: string;
  source: string;
  listing_hash: string;
  updated_at: number;
}

const COLUMNS = 'sku, title, description, brand, category, image_url, price_cents, currency, available, merchant_domain, url, source, listing_hash, updated_at';

const toProduct = (r: ProductRow): StoreProduct => ({
  sku: r.sku,
  title: r.title,
  description: r.description,
  brand: r.brand,
  category: r.category,
  imageUrl: r.image_url,
  priceCents: r.price_cents,
  currency: r.currency,
  available: r.available,
  merchantDomain: r.merchant_domain,
  url: r.url,
  source: r.source,
  listingHash: r.listing_hash,
  updatedAt: r.updated_at,
});

/** What a catalog product looks like once the store has listed it, with its hash recomputed from the stored fields. */
function asCatalogProduct(p: StoreProduct): Product {
  return {
    id: p.sku,
    title: p.title,
    description: p.description,
    brand: p.brand,
    category: p.category as Product['category'],
    imageUrl: p.imageUrl,
    priceCents: p.priceCents,
    currency: p.currency,
    availability: p.available ? 'in_stock' : 'out_of_stock',
    merchantDomain: p.merchantDomain,
    url: p.url,
    source: p.source === 'channel3' ? 'channel3' : 'fixture',
  };
}

export class StoreError extends Error {
  override readonly name = 'StoreError';
}

export class StoreService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** List (or relist) a catalog product at the retailer's current price. */
  async list(product: Product, q: Queryable = this.db): Promise<StoreProduct> {
    const at = nowSeconds(this.clock);
    await q.query(
      `INSERT INTO store_products (${COLUMNS.replace('updated_at', 'snapshot, updated_at')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
       ON CONFLICT (sku) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, brand = EXCLUDED.brand, category = EXCLUDED.category,
         image_url = EXCLUDED.image_url, price_cents = EXCLUDED.price_cents, currency = EXCLUDED.currency, available = EXCLUDED.available,
         merchant_domain = EXCLUDED.merchant_domain, url = EXCLUDED.url, source = EXCLUDED.source, listing_hash = EXCLUDED.listing_hash,
         snapshot = EXCLUDED.snapshot, updated_at = EXCLUDED.updated_at`,
      [
        product.id,
        product.title,
        product.description,
        product.brand,
        product.category,
        product.imageUrl,
        product.priceCents,
        product.currency,
        isAvailable(product),
        product.merchantDomain,
        product.url,
        product.source,
        listingHash(product),
        json(listingSnapshot(product)),
        at,
      ],
    );
    return (await this.get(product.id, q)) as StoreProduct;
  }

  async seedFixtures(): Promise<number> {
    for (const product of FIXTURE_PRODUCTS) {
      const existing = await this.get(product.id);
      if (existing === null) await this.list(product);
    }
    return FIXTURE_PRODUCTS.length;
  }

  async get(sku: string, q: Queryable = this.db): Promise<StoreProduct | null> {
    const row = maybeOne(await q.query<ProductRow>(`SELECT ${COLUMNS} FROM store_products WHERE sku = $1`, [sku]));
    return row === null ? null : toProduct(row);
  }

  async all(): Promise<StoreProduct[]> {
    return (await this.db.query<ProductRow>(`SELECT ${COLUMNS} FROM store_products ORDER BY category, title`)).map(toProduct);
  }

  /** Change the price. The listing hash changes with it, so carts built from the old listing no longer match. */
  async setPrice(sku: string, priceCents: number): Promise<StoreProduct> {
    if (!Number.isSafeInteger(priceCents) || priceCents <= 0) throw new StoreError('price must be a positive whole number of cents');
    return this.update(sku, (p) => ({ ...p, priceCents }));
  }

  async setAvailability(sku: string, available: boolean): Promise<StoreProduct> {
    return this.update(sku, (p) => ({ ...p, availability: available ? 'in_stock' : 'out_of_stock' }));
  }

  /** Change what the listing says (title or description) without changing the sku: the "not as described" lever. */
  async setListingText(sku: string, text: { title?: string; description?: string }): Promise<StoreProduct> {
    return this.update(sku, (p) => ({ ...p, title: text.title ?? p.title, description: text.description ?? p.description }));
  }

  private async update(sku: string, change: (p: Product) => Product): Promise<StoreProduct> {
    const current = await this.get(sku);
    if (current === null) throw new StoreError(`unknown sku ${sku}`);
    return this.list(change(asCatalogProduct(current)));
  }

  /** Preload the offers for some skus into a synchronous lookup, as `verifyCheckout` needs. */
  async catalogFor(skus: Iterable<string>, q: Queryable = this.db): Promise<CatalogLookup> {
    const offers = new Map<string, CatalogOffer>();
    for (const sku of new Set(skus)) {
      const product = await this.get(sku, q);
      if (product !== null) {
        offers.set(sku, { unitPriceCents: product.priceCents, currency: product.currency, available: product.available, category: product.category, listingHash: product.listingHash });
      }
    }
    return (sku) => offers.get(sku) ?? null;
  }

  // ---- settings -----------------------------------------------------------------------------------------------------

  async merchantMode(q: Queryable = this.db): Promise<MerchantMode> {
    const row = maybeOne(await q.query<{ value: string }>("SELECT value FROM settings WHERE key = 'merchant_mode'"));
    return row?.value === 'PERMISSIVE' || row?.value === 'NONE' ? row.value : 'STRICT';
  }

  async setMerchantMode(mode: MerchantMode): Promise<void> {
    await this.db.query("INSERT INTO settings (key, value) VALUES ('merchant_mode', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [json(mode)]);
  }
}
