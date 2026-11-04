import { hashJson } from '@warrant/warrant';
import type { Availability, Category, ListingSnapshot, Product } from './types';

export function isAvailable(product: Pick<Product, 'availability'>): boolean {
  return product.availability === 'in_stock' || product.availability === 'limited';
}

/** The fields a listing hash commits to. The image is excluded: it changes without changing what is for sale. */
export function listingSnapshot(product: Product): ListingSnapshot {
  return {
    id: product.id,
    title: product.title,
    description: product.description,
    brand: product.brand,
    category: product.category,
    priceCents: product.priceCents,
    currency: product.currency,
    availability: product.availability,
    merchantDomain: product.merchantDomain,
    url: product.url,
  };
}

/** `sha256:` hash of the canonical listing snapshot: the `listing_hash` carried by a cart line. */
export function listingHash(product: Product): string {
  return hashJson(listingSnapshot(product));
}

interface Rule {
  readonly category: Category;
  readonly pattern: RegExp;
}

/** Ordered: the first match wins, and the risky categories are checked first on purpose. */
const RULES: readonly Rule[] = [
  { category: 'gift_cards', pattern: /\bgift[\s-]?cards?\b|\be-?gift\b|\bgift certificate/i },
  { category: 'prepaid_cards', pattern: /\bprepaid\b|\bdebit card reload\b|\bload(?:able)? card\b|\bmoney order\b/i },
  { category: 'crypto', pattern: /\bcrypto(?:currency)?\b|\bbitcoin\b|\bethereum\b|\bbtc\b|\bnft\b|\btoken voucher\b/i },
  { category: 'gambling', pattern: /\bcasino\b|\bgambl|\bsportsbook\b|\blottery\b|\bpoker (?:chips|credit)|\bbetting\b/i },
  { category: 'adult', pattern: /\badult (?:toy|novelty|only)\b|\bxxx\b|\berotic\b|\bsex toy\b/i },
  { category: 'office_furniture', pattern: /\bstanding desk\b|\bdesk converter\b|\boffice chair\b|\bergonomic\b|\bmonitor (?:arm|stand)\b|\bfootrest\b|\banti-fatigue\b|\bdesk\b|\boffice furniture\b/i },
  { category: 'electronics', pattern: /\bheadphones?\b|\bkeyboard\b|\bmouse\b|\bwebcam\b|\busb\b|\bcharger\b|\bspeaker\b|\bpower bank\b|\bmonitor\b|\blaptop\b|\bcable\b|\belectronics?\b/i },
  { category: 'books', pattern: /\bbooks?\b|\bnovel\b|\bpaperback\b|\bhardcover\b|\bmemoir\b/i },
  { category: 'kitchen', pattern: /\bcoffee\b|\bkettle\b|\bkitchen\b|\bcookware\b|\bblender\b|\bwater bottle\b|\bknife\b/i },
  { category: 'home', pattern: /\bhome\b|\blamp\b|\bblanket\b|\bpillow\b|\bplant\b|\bdecor\b|\bcandle\b|\borganizer\b/i },
];

/**
 * Infer a Warrant category from catalog text. Best-effort and deliberately conservative: it looks at the title and the
 * retailer's own category first, and only then at the description, so a stray word in a long description cannot move
 * an ordinary product into a risky category.
 */
export function categorize(input: { title: string; category?: string | null; description?: string | null }): Category {
  const primary = `${input.title} ${input.category ?? ''}`;
  for (const rule of RULES) {
    if (rule.pattern.test(primary)) return rule.category;
  }
  const description = input.description ?? '';
  for (const rule of RULES) {
    if (RISKY.has(rule.category) && rule.pattern.test(description.slice(0, 400))) return rule.category;
  }
  return 'other';
}

const RISKY: ReadonlySet<Category> = new Set<Category>(['gift_cards', 'prepaid_cards', 'crypto', 'gambling', 'adult']);

export function mapAvailability(raw: unknown): Availability {
  switch (raw) {
    case 'InStock':
    case 'in_stock':
      return 'in_stock';
    case 'LimitedAvailability':
    case 'limited':
      return 'limited';
    default:
      // SoldOut, OutOfStock, PreOrder, BackOrder, or anything unknown: not something the store can ship now.
      return 'out_of_stock';
  }
}
