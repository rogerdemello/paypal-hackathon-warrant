import type { Cents, NumericDate } from '@warrant/warrant';

/** Domain types. Money is integer cents here; decimal strings exist only inside this package's mappers. */

// ---------------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------------

export interface OrderLineInput {
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitCents: Cents;
}

export interface CreateOrderInput {
  readonly referenceId: string;
  /** `wrt:<cart jti>` */
  readonly customId: string;
  /** `WRT-<first 16 chars of cart_hash>` */
  readonly invoiceId: string;
  readonly description: string;
  readonly currency: string;
  readonly lines: readonly OrderLineInput[];
  readonly totalCents: Cents;
  readonly brandName: string;
  readonly returnUrl: string;
  readonly cancelUrl: string;
}

export interface OrderLine {
  readonly sku: string | null;
  readonly name: string | null;
  readonly quantity: number;
  readonly unitAmountCents: Cents;
}

export interface CaptureSummary {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
  readonly amountCents: Cents;
  readonly invoiceId: string | null;
  readonly customId: string | null;
  readonly createdAt: NumericDate | null;
}

export interface OrderSummary {
  readonly id: string;
  /** CREATED, APPROVED, COMPLETED, ... */
  readonly status: string;
  readonly currency: string;
  readonly totalCents: Cents;
  readonly customId: string | null;
  readonly invoiceId: string | null;
  readonly referenceId: string | null;
  /** `payer.payer_id`, present once the buyer has approved. */
  readonly payerId: string | null;
  readonly payerEmail: string | null;
  /** `purchase_units[0].items`, or null when the order carries no line items. */
  readonly lines: readonly OrderLine[] | null;
  readonly captures: readonly CaptureSummary[];
  /** The `payer-action` (or older `approve`) link the buyer is sent to. */
  readonly approveUrl: string | null;
}

export interface TrackingInput {
  readonly captureId: string;
  readonly trackingNumber: string;
  readonly carrier: string;
  readonly notifyPayer?: boolean;
}

export interface RefundInput {
  readonly captureId: string;
  readonly currency: string;
  /** Omit for a full refund. */
  readonly amountCents?: Cents;
  readonly note?: string;
  readonly invoiceId?: string;
}

export interface RefundSummary {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
  readonly amountCents: Cents;
}

// ---------------------------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------------------------

export type DisputeReason =
  | 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED'
  | 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED'
  | 'UNAUTHORISED'
  | 'CREDIT_NOT_PROCESSED'
  | 'DUPLICATE_TRANSACTION'
  | 'INCORRECT_AMOUNT'
  | 'PAYMENT_BY_OTHER_MEANS'
  | 'CANCELED_RECURRING_BILLING'
  | 'PROBLEM_WITH_REMITTANCE'
  | 'OTHER';

export type DisputeStatus = 'OPEN' | 'WAITING_FOR_BUYER_RESPONSE' | 'WAITING_FOR_SELLER_RESPONSE' | 'UNDER_REVIEW' | 'RESOLVED' | 'OTHER';
export type DisputeStage = 'INQUIRY' | 'CHARGEBACK' | 'PRE_ARBITRATION' | 'ARBITRATION';
export type AcceptClaimType = 'REFUND' | 'REFUND_WITH_RETURN' | 'PARTIAL_REFUND' | 'REFUND_WITH_RETURN_SHIPMENT_LABEL';
export type OfferType = 'REFUND' | 'REFUND_WITH_RETURN' | 'REFUND_WITH_REPLACEMENT' | 'REPLACEMENT_WITHOUT_REFUND';
export type AcceptClaimReason = 'DID_NOT_SHIP_ITEM' | 'TOO_TIME_CONSUMING' | 'LOST_IN_MAIL' | 'NOT_ABLE_TO_WIN' | 'COMPANY_POLICY' | 'REASON_NOT_SET';

export interface DisputeMessage {
  readonly postedBy: string;
  readonly content: string;
  readonly timePosted: NumericDate | null;
}

export interface DisputeEvidenceSummary {
  readonly evidenceType: string;
  readonly source: string | null;
  readonly notes: string | null;
}

export interface DisputeSummary {
  readonly id: string;
  readonly reason: string;
  readonly status: string;
  readonly stage: string | null;
  readonly currency: string;
  readonly amountCents: Cents;
  /** `disputed_transactions[].seller_transaction_id`: a capture id for orders made through Warrant. */
  readonly sellerTransactionIds: readonly string[];
  readonly createdAt: NumericDate | null;
  readonly updatedAt: NumericDate | null;
  readonly sellerResponseDueBy: NumericDate | null;
  readonly messages: readonly DisputeMessage[];
  readonly evidences: readonly DisputeEvidenceSummary[];
  /** `allowed_response_options.accept_claim.accept_claim_types` */
  readonly allowedAcceptClaimTypes: readonly string[];
  /** `allowed_response_options.make_offer.offer_types` */
  readonly allowedOfferTypes: readonly string[];
  readonly outcomeCode: string | null;
}

export interface DisputeListQuery {
  readonly status?: string;
  readonly pageSize?: number;
}

export interface AcceptClaimInput {
  readonly note: string;
  readonly reason?: AcceptClaimReason;
  readonly invoiceId?: string;
  readonly acceptClaimType?: AcceptClaimType;
  /** Required for a partial refund. */
  readonly refundAmount?: { readonly currency: string; readonly cents: Cents };
}

export interface MakeOfferInput {
  readonly note: string;
  readonly offerType: OfferType;
  readonly offerAmount?: { readonly currency: string; readonly cents: Cents };
  readonly invoiceId?: string;
}

export interface EvidenceInput {
  readonly evidenceType: string;
  readonly notes?: string;
  readonly trackingInfo?: ReadonlyArray<{ readonly carrierName: string; readonly trackingNumber: string }>;
  readonly refundIds?: readonly string[];
}

export interface EvidenceFile {
  readonly name: string;
  readonly contentType: string;
  readonly data: Uint8Array;
}

export interface ProvideEvidenceInput {
  readonly evidences: readonly EvidenceInput[];
  readonly files?: readonly EvidenceFile[];
}

export interface SandboxCreateDisputeInput {
  readonly sellerTransactionId: string;
  readonly reason: DisputeReason;
  readonly currency: string;
  readonly amountCents: Cents;
  readonly message: string;
}

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

export interface WebhookEvent {
  readonly id: string;
  readonly eventType: string;
  readonly resourceType: string | null;
  readonly createdAt: NumericDate | null;
  readonly summary: string | null;
  readonly resource: unknown;
}

/** The headers PayPal sends with each webhook delivery (lower-case names). */
export interface WebhookHeaders {
  readonly authAlgo: string;
  readonly certUrl: string;
  readonly transmissionId: string;
  readonly transmissionSig: string;
  readonly transmissionTime: string;
}
