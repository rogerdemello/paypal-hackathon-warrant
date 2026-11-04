/**
 * Shapes shared between the server and the web app. Types only: the web app imports them with `import type`, so nothing
 * from the server is bundled. Money is integer cents; instants are NumericDate seconds unless named `*Iso`.
 */

export interface FindingDto {
  readonly rule: string;
  readonly outcome: 'pass' | 'review' | 'reject';
  readonly detail: string;
}

export interface ProductDto {
  readonly sku: string;
  readonly title: string;
  readonly brand: string | null;
  readonly category: string;
  readonly imageUrl: string | null;
  readonly priceCents: number;
  readonly currency: string;
  readonly merchantDomain: string;
  readonly available: boolean;
}

export interface MandateTermsDto {
  readonly instructionText: string;
  readonly maxTotalCents: number;
  readonly maxPerItemCents: number;
  readonly maxItems: number;
  readonly categoriesAllow: readonly string[] | null;
  readonly mode: 'human_present' | 'human_not_present';
  readonly budgetMode: 'cumulative' | 'per_cart';
  readonly validForSeconds: number;
}

/** The consent screen, exactly as the wallet rendered it (and hashed). */
export interface PresentedScreenDto {
  readonly screen: 'warrant.consent.v1';
  readonly merchant: { readonly audience: string; readonly name: string };
  readonly principal: string;
  readonly agent: string;
  readonly instruction: string;
  readonly items: ReadonlyArray<{ readonly sku: string; readonly title: string; readonly qty: number; readonly unit_price: string; readonly line_total: string }>;
  readonly currency: string;
  readonly total: string;
  readonly limits: { readonly max_total: string; readonly max_per_item: string; readonly max_items: number; readonly budget_mode: string; readonly mode: string };
  readonly expires_at: string;
}

export interface ProposalDto {
  readonly id: string;
  readonly mandateJti: string;
  readonly cartJti: string;
  readonly status: 'pending' | 'approved' | 'declined' | 'expired';
  readonly presented: PresentedScreenDto;
  readonly presentedHash: string;
  readonly cartHash: string;
  readonly expiresAt: number;
  readonly createdAt: number;
}

export type AgentPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'notice'; readonly level: 'info' | 'warn' | 'error'; readonly text: string }
  | { readonly kind: 'mandate_request'; readonly terms: MandateTermsDto; readonly suggestedCategories: readonly string[]; readonly resolved: boolean }
  | { readonly kind: 'products'; readonly items: readonly ProductDto[]; readonly chosenSku: string | null; readonly reason: string | null }
  | { readonly kind: 'cart_proposal'; readonly proposalId: string }
  | {
      readonly kind: 'checkout';
      readonly status: 'rejected' | 'pending_review' | 'approval_required' | 'failed';
      readonly orderId: string | null;
      readonly approvalUrl: string | null;
      readonly message: string;
      readonly findings: readonly FindingDto[];
    }
  | {
      readonly kind: 'order';
      readonly orderId: string;
      readonly status: string;
      readonly totalCents: number;
      readonly currency: string;
      readonly cartJti: string | null;
      readonly message: string;
    };

export interface AgentMessageDto {
  readonly id: string;
  readonly seq: number;
  readonly role: 'user' | 'assistant';
  readonly parts: readonly AgentPart[];
  readonly createdAt: number;
}

export interface AgentSessionDto {
  readonly id: string;
  readonly mandateJti: string | null;
  readonly stage: 'start' | 'awaiting_mandate' | 'awaiting_consent' | 'checking_out' | 'done';
  readonly createdAt: number;
  readonly messages: readonly AgentMessageDto[];
}

export interface FactDto {
  readonly id: string;
  readonly name: string;
  readonly value: boolean;
  readonly evidence: readonly string[];
}

export interface SignerDto {
  readonly subject: 'mandate' | 'cart' | 'consent';
  readonly kid: string | null;
  readonly ok: boolean;
  readonly detail: string;
  /** Registry status of the key now, or null when the kid is not in the registry. */
  readonly keyStatus: string | null;
  readonly owner: string | null;
}

/** Everything the public verification page (`/v/:cartJti`) shows. */
export interface VerificationReportDto {
  readonly found: boolean;
  readonly cartJti: string;
  readonly mandate: {
    readonly jti: string;
    readonly hash: string;
    readonly instruction: string;
    readonly issuer: string;
    readonly validFrom: number;
    readonly validUntil: number;
    readonly scope: {
      readonly currency: string;
      readonly maxTotal: string;
      readonly maxPerItem: string;
      readonly maxItems: number;
      readonly categoriesAllow: readonly string[] | null;
      readonly mode: string;
      readonly budgetMode: string;
    };
    readonly payerLinked: boolean;
  } | null;
  readonly cart: {
    readonly issuer: string;
    readonly audience: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
    readonly cartHash: string;
    readonly total: string;
    readonly currency: string;
    readonly items: ReadonlyArray<{ readonly sku: string; readonly title: string; readonly qty: number; readonly unit_price: string; readonly listing_hash: string }>;
    readonly consent: { readonly mode: string; readonly approvedAt: string | null; readonly method: string | null; readonly presentedHash: string | null };
  } | null;
  readonly signers: readonly SignerDto[];
  readonly facts: readonly FactDto[];
  /** What the merchant's verifier found when it accepted the cart. */
  readonly checkoutFindings: readonly FindingDto[];
  readonly order: { readonly id: string; readonly status: string; readonly totalCents: number; readonly currency: string; readonly paypalOrderId: string | null; readonly captureId: string | null; readonly createdAt: number } | null;
  readonly transparency: {
    readonly included: boolean;
    readonly seq: number | null;
    readonly entryHash: string | null;
    readonly loggedAt: number | null;
    readonly proofValid: boolean | null;
    readonly proofReason: string | null;
    readonly checkpointSeq: number | null;
  };
  readonly dispute: { readonly id: string; readonly state: string; readonly outcome: string | null; readonly rule: string | null } | null;
  readonly generatedAt: number;
}

export * from './api-types-console';
