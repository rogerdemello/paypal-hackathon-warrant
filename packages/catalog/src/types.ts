import type { Cents } from '@warrant/warrant';

/** A product as the shopping agent and the demo store see it. Money is integer cents. */

export type Availability = 'in_stock' | 'limited' | 'out_of_stock';

/**
 * Category slugs used by mandate category rules. Inferred from catalog data, so best-effort: a slug is a hint about the
 * listing, not a merchant category code. The risky slugs come first so a gift card sold as "office supplies" is still caught.
 */
export const CATEGORIES = [
  'gift_cards',
  'prepaid_cards',
  'crypto',
  'gambling',
  'adult',
  'office_furniture',
  'electronics',
  'books',
  'kitchen',
  'home',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Categories a typical mandate denies by default (docs/warrant-spec.md example). */
export const RISKY_CATEGORIES: readonly Category[] = ['gift_cards', 'prepaid_cards', 'crypto', 'gambling', 'adult'];

export interface Product {
  /** Channel3 canonical product id, or a fixture id. Used as the cart line `sku`. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly brand: string | null;
  readonly category: Category;
  readonly imageUrl: string | null;
  readonly priceCents: Cents;
  readonly currency: string;
  readonly availability: Availability;
  /** The retailer the offer comes from. */
  readonly merchantDomain: string;
  readonly url: string;
  readonly source: 'fixture' | 'channel3';
}

export interface SearchOptions {
  readonly maxPriceCents?: Cents;
  readonly limit?: number;
}

export interface Catalog {
  search(query: string, options?: SearchOptions): Promise<Product[]>;
  get(id: string): Promise<Product | null>;
}

/** What `listing_hash` commits to: everything a buyer relies on when choosing, nothing cosmetic. */
export interface ListingSnapshot {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly brand: string | null;
  readonly category: Category;
  readonly priceCents: Cents;
  readonly currency: string;
  readonly availability: Availability;
  readonly merchantDomain: string;
  readonly url: string;
}

export class CatalogError extends Error {
  override readonly name = 'CatalogError';
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}
