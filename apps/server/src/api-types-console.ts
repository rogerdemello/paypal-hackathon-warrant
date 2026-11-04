import type { FindingDto } from './api-types';

/** Wire shapes for configuration, the wallet, the merchant console, the registry and the Dispute Lab. Types only. */

export interface PublicConfigDto {
  readonly mode: 'live' | 'fixtures';
  readonly paypalEnv: 'sandbox' | 'simulator';
  readonly merchantName: string;
  readonly merchantId: string;
  readonly judgeMode: boolean;
  readonly consoleTokenRequired: boolean;
  readonly publicBaseUrl: string;
}

export interface WalletMeDto {
  readonly id: string;
  readonly displayName: string;
  readonly payerLinked: boolean;
  readonly canLinkSandboxBuyer: boolean;
}

export interface MandateDto {
  readonly jti: string;
  readonly hash: string;
  readonly status: 'active' | 'revoked';
  readonly instruction: string;
  readonly validFrom: number;
  readonly validUntil: number;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly scope: {
    readonly currency: string;
    readonly maxTotal: string;
    readonly maxPerItem: string;
    readonly maxItems: number;
    readonly categoriesAllow: readonly string[] | null;
    readonly mode: string;
    readonly budgetMode: string;
  };
  readonly agent: string;
  /** The signed mandate, so the holder can show or check it independently. */
  readonly jws: string;
}

// ---- merchant console ----------------------------------------------------------------------------------------------------

export interface OverviewDto {
  readonly mode: 'live' | 'fixtures';
  readonly paypalEnv: 'sandbox' | 'simulator';
  readonly merchantMode: 'STRICT' | 'PERMISSIVE' | 'NONE';
  readonly autopilot: boolean;
  readonly orders: { readonly total: number; readonly byStatus: Readonly<Record<string, number>>; readonly capturedCents: number };
  readonly attempts: { readonly total: number; readonly accepted: number; readonly review: number; readonly rejected: number };
  readonly disputes: { readonly total: number; readonly byState: Readonly<Record<string, number>>; readonly needAttention: number };
  readonly keys: ReadonlyArray<{ readonly kid: string; readonly kind: string; readonly owner: string; readonly status: string }>;
  readonly transparency: { readonly length: number; readonly headHash: string | null };
}

export interface OrderRowDto {
  readonly id: string;
  readonly status: string;
  readonly createdAt: number;
  readonly totalCents: number;
  readonly currency: string;
  readonly itemCount: number;
  readonly items: string;
  readonly cartJti: string | null;
  readonly mandateJti: string | null;
  readonly verifierMode: string;
  readonly verification: string;
  readonly rejectedRules: readonly string[];
  readonly paypalOrderId: string | null;
  readonly captureId: string | null;
  readonly invoiceId: string | null;
  readonly trackingStatus: string | null;
  readonly trackingNumber: string | null;
  readonly refundedCents: number;
  readonly note: string | null;
  /** Created by a Dispute Lab scenario rather than a shopper. */
  readonly lab: boolean;
}

export interface LedgerEntryDto {
  readonly chainId: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly prevHash: string;
  readonly hash: string;
  readonly createdAt: number;
}

export interface LedgerVerificationDto {
  readonly ok: boolean;
  readonly length?: number;
  readonly headSeq?: number | null;
  readonly headHash?: string | null;
  readonly brokenSeq?: number;
  readonly reason?: string;
  readonly message?: string;
}

export interface OrderDetailDto {
  readonly order: {
    readonly id: string;
    readonly status: string;
    readonly lines: ReadonlyArray<{ readonly sku: string; readonly title: string; readonly qty: number; readonly unitPriceCents: number }>;
    readonly verification: { readonly outcome: string; readonly findings: readonly FindingDto[]; readonly payer?: FindingDto };
    readonly note: string | null;
  };
  readonly row: OrderRowDto;
  readonly tracking: { readonly carrier: string; readonly trackingNumber: string; readonly status: string; readonly shippedAt: number; readonly deliveredAt: number | null; readonly promisedBy: number | null } | null;
  readonly refunds: ReadonlyArray<{ readonly id: string; readonly amountCents: number; readonly createdAt: number }>;
  readonly ledger: { readonly chainId: string; readonly entries: readonly LedgerEntryDto[]; readonly verification: LedgerVerificationDto };
}

export interface AttemptRowDto {
  readonly id: string;
  readonly createdAt: number;
  readonly cartJti: string | null;
  readonly outcome: string;
  readonly orderId: string | null;
  readonly failedRules: readonly string[];
  readonly reasons: readonly string[];
  readonly findings: readonly FindingDto[];
  readonly lab: boolean;
}

export interface ProductRowDto {
  readonly sku: string;
  readonly title: string;
  readonly category: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly available: boolean;
  readonly listingHash: string;
  readonly merchantDomain: string;
  readonly source: string;
}

export interface DisputeRowDto {
  readonly id: string;
  readonly orderId: string | null;
  readonly captureId: string | null;
  readonly reason: string;
  readonly status: string;
  readonly stage: string | null;
  readonly state: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly claim: string | null;
  readonly claimConflict: boolean;
  readonly responseDueBy: number | null;
  readonly hoursLeft: number | null;
  readonly outcome: string | null;
  readonly rule: string | null;
  readonly confidence: string | null;
  readonly action: string | null;
  readonly actionStatus: string | null;
  readonly actionId: string | null;
  readonly approvedBy: string | null;
  readonly createdAt: number;
  readonly lab: boolean;
}

export interface FactFullDto {
  readonly id: string;
  readonly name: string;
  readonly value: boolean | number | null;
  readonly evidence: readonly string[];
}

export interface DecisionDto {
  readonly claim: string;
  readonly outcome: string;
  readonly rule: string;
  readonly action: { readonly type: string; readonly detail?: string };
  readonly alternatives: ReadonlyArray<{ readonly type: string; readonly detail?: string }>;
  readonly confidence: 'normal' | 'low';
  readonly attribution: { readonly agent_platform: string; readonly merchant: string; readonly principal: string };
  readonly factsUsed: readonly string[];
  readonly flags: readonly string[];
  readonly caveat: string;
  readonly claimConflict: boolean;
  readonly claimSource: string;
}

export interface DisputeActionDto {
  readonly id: string;
  readonly actionType: string;
  readonly status: string;
  readonly outcome: string;
  readonly rule: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly memo: string;
  readonly evidenceNote: string;
  readonly buyerMessage: string;
  readonly noteSource: string;
  readonly approvedBy: string | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

export interface DisputeDetailDto {
  readonly dispute: {
    readonly id: string;
    readonly reason: string;
    readonly status: string;
    readonly stage: string | null;
    readonly state: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly buyerMessage: string | null;
    readonly claimType: string | null;
    readonly claimConflict: boolean;
    readonly responseDueBy: number | null;
    readonly outcomeCode: string | null;
    readonly createdAt: number;
  };
  readonly row: DisputeRowDto;
  readonly order: { readonly id: string; readonly status: string; readonly totalCents: number; readonly currency: string } | null;
  readonly analysis: {
    readonly id: string;
    readonly computedAt: number;
    readonly facts: Readonly<Record<string, FactFullDto | undefined>>;
    readonly decision: DecisionDto;
  } | null;
  readonly actions: readonly DisputeActionDto[];
  readonly packet: { readonly fileName: string; readonly sha256: string; readonly sizeBytes: number } | null;
  readonly ledger: { readonly chainId: string; readonly entries: readonly LedgerEntryDto[]; readonly verification: LedgerVerificationDto };
  readonly verifyUrl: string | null;
}

export interface RegistryKeyDto {
  readonly kid: string;
  readonly kind: string;
  readonly owner: string;
  readonly status: string;
  readonly valid_from: number;
  readonly valid_to: number | null;
  readonly status_changed_at: number | null;
}

export interface RegistryLogDto {
  readonly head: LedgerEntryDto | null;
  readonly checkpoint: { readonly seq: number; readonly headHash: string; readonly issuedAt: number } | null;
  readonly logKey: { readonly kid: string; readonly publicKey: string };
  readonly entries: readonly LedgerEntryDto[];
}

export interface RegistryAuditDto {
  readonly ok: boolean;
  readonly length: number;
  readonly headSeq: number | null;
  readonly headHash: string | null;
  readonly problems: ReadonlyArray<{ readonly code: string; readonly message: string; readonly seq?: number }>;
}

// ---- Dispute Lab ---------------------------------------------------------------------------------------------------------

export interface ScenarioDto {
  readonly id: string;
  readonly family: string;
  readonly familyTitle: string;
  readonly title: string;
  readonly story: string;
  readonly merchantMode: string;
  readonly attack: string | null;
  readonly dispute: { readonly reason: string; readonly message: string } | null;
  readonly expect: {
    readonly verifier: string;
    readonly rejectedRules?: readonly string[];
    readonly sold: boolean;
    readonly payment?: string;
    readonly dispute?: { readonly claim: string; readonly outcome: string; readonly rule: string; readonly action: string };
  };
  readonly runnable: boolean;
}

export interface ScenarioResultDto {
  readonly id: string;
  readonly family: string;
  readonly title: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly steps: ReadonlyArray<{ readonly name: string; readonly detail: string; readonly ok: boolean }>;
  readonly actual: {
    readonly verifier: string | null;
    readonly rejectedRules: readonly string[];
    readonly sold: boolean;
    readonly payment: string | null;
    readonly orderId: string | null;
    readonly cartJti: string | null;
    readonly disputeId: string | null;
    readonly claim: string | null;
    readonly outcome: string | null;
    readonly rule: string | null;
    readonly action: string | null;
    readonly attribution: { readonly agent_platform: string; readonly merchant: string; readonly principal: string } | null;
    readonly flags: readonly string[];
    readonly confidence: string | null;
    readonly state: string | null;
    readonly noteSource: string | null;
  };
  readonly latencyMs: number | null;
  readonly durationMs: number;
}

export interface ScenarioListDto {
  readonly families: ReadonlyArray<{ readonly id: string; readonly title: string; readonly count: number }>;
  readonly simulator: boolean;
  readonly scenarios: readonly ScenarioDto[];
}
