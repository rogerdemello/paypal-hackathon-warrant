import { formatInstant, formatMoney, type Facts, type OutcomeDecision } from '@warrant/warrant';
import { LlmBudgetError, LlmError, extractJsonObject, type LlmClient } from './llm';

/**
 * The words around a dispute decision: a liability memo for the merchant, a note for PayPal's evidence form and a message
 * to the buyer. The decision itself is already made by the outcome table; this module only describes it.
 *
 * Anything a model writes is checked against the case record before it is used: every identifier, amount and date in the
 * text must already appear in the facts, the decision or the case record. A model that invents a tracking number, a refund
 * or a date is discarded and the template text is used instead.
 */

/** The case record the notes are written from: plain values the dispute service already holds. */
export interface CaseRecord {
  readonly disputeId: string;
  readonly reason: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly orderId: string | null;
  readonly captureId: string | null;
  readonly cartJti: string | null;
  readonly cartHash: string | null;
  /** Instants as NumericDate seconds. */
  readonly consentApprovedAt: string | null;
  readonly items: ReadonlyArray<{ readonly title: string; readonly qty: number }>;
  readonly tracking: { readonly carrier: string; readonly number: string; readonly deliveredAt: number | null } | null;
  readonly refundIds: readonly string[];
  readonly verifyUrl: string | null;
  readonly merchantName: string;
}

export interface NoteInput {
  readonly facts: Facts;
  readonly decision: OutcomeDecision;
  readonly record: CaseRecord;
}

export interface DisputeNotes {
  /** For the merchant: what was decided, why and who the facts point at. Advisory. */
  readonly memo: string;
  /** Goes to PayPal as the evidence note. */
  readonly evidenceNote: string;
  /** Goes to the buyer through PayPal. */
  readonly buyerMessage: string;
  readonly source: 'template' | 'model' | 'template (model output rejected)';
  readonly rejectedBecause?: readonly string[];
}

export interface NoteWriter {
  write(input: NoteInput): Promise<DisputeNotes>;
}

const money = (cents: number, currency: string): string => `${formatMoney(cents)} ${currency}`;
const yesNo = (v: boolean): string => (v ? 'yes' : 'no');

const OUTCOME_SUMMARY: Record<OutcomeDecision['outcome'], string> = {
  FIGHT: 'The warrant shows the buyer authorised this purchase and the order matches it. The merchant should contest the dispute with the evidence packet.',
  ACCEPT_AGENT_FAULT: 'The record shows the purchase went beyond what the buyer authorised, and the fault lies with the agent platform rather than the merchant. The recommendation is to accept the claim and recover from the agent platform where an agreement exists.',
  NO_PROOF: 'There is not enough verifiable proof to contest this dispute. The recommendation is to accept it.',
  REFUND_MERCHANT_FAULT: 'The record points to a problem on the merchant side, so the recommendation is to refund or offer a remedy.',
  ACCEPT: 'The facts support the buyer. The recommendation is to accept the claim.',
  ALREADY_RESOLVED: 'The buyer has already been refunded, so no further action is needed.',
  ESCALATE_TO_HUMAN: 'The facts do not support an automatic recommendation. A person should decide.',
};

function attributionLine(decision: OutcomeDecision): string {
  const a = decision.attribution;
  return `agent platform ${a.agent_platform}, merchant ${a.merchant}, buyer ${a.principal}`;
}

/** Deterministic notes built straight from the case record. Always grounded, by construction. */
export class TemplateNoteWriter implements NoteWriter {
  write({ facts, decision, record }: NoteInput): Promise<DisputeNotes> {
    const amount = money(record.amountCents, record.currency);
    const flagText = decision.flags.length > 0 ? ` Flags: ${decision.flags.join(', ')}.` : '';
    const memo = [
      `Dispute ${record.disputeId} (${record.reason}) for ${amount}${record.orderId === null ? '' : ` on order ${record.orderId}`}.`,
      `Claim: ${decision.claim}. Outcome: ${decision.outcome} (rule ${decision.rule}). Proposed action: ${decision.action.type}${decision.action.detail === undefined ? '' : ` / ${decision.action.detail}`}.`,
      OUTCOME_SUMMARY[decision.outcome],
      `Responsibility from the facts: ${attributionLine(decision)}.`,
      `Warrant present: ${yesNo(facts.F1.value)}. Signatures valid: ${yesNo(facts.F2.value)}. Keys active at issue: ${yesNo(facts.F3.value)}. Consent valid: ${yesNo(facts.F4.value)}. Order matches consent: ${yesNo(facts.F5.value)}. Within mandate: ${yesNo(facts.F6.value)}. Payer bound: ${yesNo(facts.F7.value)}. Delivered: ${yesNo(facts.F9.value)}. Listing matches: ${yesNo(facts.F10.value)}.${flagText}`,
      decision.caveat,
    ].join('\n');

    const lines: string[] = [];
    if (facts.F1.value && record.cartJti !== null) {
      lines.push(`A signed warrant (cart ${record.cartJti}) records what the buyer's wallet authorised for this order${record.consentApprovedAt === null ? '' : `, approved at ${record.consentApprovedAt}`}.`);
      lines.push(`Signatures valid: ${yesNo(facts.F2.value)}. Consent valid: ${yesNo(facts.F4.value)}. The order matches the consented cart: ${yesNo(facts.F5.value)}.`);
    } else {
      lines.push('No signed warrant is on file for this order.');
    }
    if (record.items.length > 0) lines.push(`Items: ${record.items.map((i) => `${i.qty} x ${i.title}`).join('; ')}.`);
    if (record.captureId !== null) lines.push(`Payment ${record.captureId} for ${amount}.`);
    if (record.tracking !== null) {
      lines.push(`Shipped with ${record.tracking.carrier}, tracking ${record.tracking.number}${record.tracking.deliveredAt === null ? ', not yet marked delivered' : `, delivered ${formatInstant(record.tracking.deliveredAt)}`}.`);
    }
    if (record.verifyUrl !== null) lines.push(`Anyone can verify this record at ${record.verifyUrl}`);
    const evidenceNote = lines.join('\n');

    const buyerMessage =
      decision.outcome === 'ACCEPT' || decision.outcome === 'ACCEPT_AGENT_FAULT' || decision.outcome === 'NO_PROOF' || decision.outcome === 'REFUND_MERCHANT_FAULT'
        ? `We are sorry for the trouble with your order${record.orderId === null ? '' : ` ${record.orderId}`}. We are resolving dispute ${record.disputeId} in your favour for ${amount}.`
        : `Thank you for contacting us about order${record.orderId === null ? '' : ` ${record.orderId}`}. We reviewed dispute ${record.disputeId} and the signed record of your purchase, and we have sent that record to PayPal for review.`;

    return Promise.resolve({ memo, evidenceNote, buyerMessage, source: 'template' });
  }
}

// ---- grounding check -----------------------------------------------------------------------------------------------

const TOKENS = [
  /sha256:[A-Za-z0-9_-]{43}/g,
  /\b(?:PP-D-\d+|SIM[A-Z]+\d+|(?:ord|crt|mdt|prp|att|dsp|act)_[A-Za-z0-9]+|WRT-[A-Za-z0-9_-]+|wrt:[A-Za-z0-9_.:-]+|1Z[A-Z0-9]{8,})\b/g,
  /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?/g,
  /\$\s?\d[\d,]*(?:\.\d{1,2})?/g,
  /\b\d[\d,]*\.\d{2}\b/g,
  /\b\d{6,}\b/g,
];

function normalise(token: string): string {
  return token.replace(/^\$\s?/, '').replace(/,/g, '');
}

/** Everything a note may mention, as one searchable string. */
export function groundingCorpus(input: NoteInput): string {
  const { record } = input;
  const extra: string[] = [];
  const addMoney = (cents: number | null) => {
    if (cents !== null && Number.isSafeInteger(cents)) extra.push(formatMoney(cents));
  };
  addMoney(record.amountCents);
  const visit = (value: unknown): void => {
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      extra.push(String(value));
      if (value > 1_000_000_000 && value < 4_000_000_000) extra.push(formatInstant(value), formatInstant(value).slice(0, 10));
      if (Math.abs(value) < 100_000_000) extra.push(formatMoney(Math.abs(value)));
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(visit);
  };
  visit(input.facts);
  visit(input.decision);
  visit(record);
  return `${JSON.stringify({ facts: input.facts, decision: input.decision, record })}\n${extra.join('\n')}`;
}

/** Identifiers, amounts and dates in `text` that the case record does not contain. */
export function ungroundedTokens(text: string, corpus: string): string[] {
  const missing = new Set<string>();
  for (const pattern of TOKENS) {
    for (const match of text.matchAll(pattern)) {
      const token = match[0];
      if (!corpus.includes(token) && !corpus.includes(normalise(token))) missing.add(token);
    }
  }
  // A bare number inside an identifier that is already reported (PP-D-777777 and 777777) is one problem, not two.
  return [...missing].filter((token) => ![...missing].some((other) => other !== token && other.includes(token)));
}

const MAX_FIELD = 4000;

/**
 * A model writes the three texts from the case record. Its output is used only if every identifier, amount and date in it is
 * already in the record; otherwise the template text replaces it.
 */
export class LlmNoteWriter implements NoteWriter {
  constructor(
    private readonly llm: LlmClient,
    private readonly fallback: NoteWriter = new TemplateNoteWriter(),
    private readonly visitorId?: string,
  ) {}

  async write(input: NoteInput): Promise<DisputeNotes> {
    const template = await this.fallback.write(input);
    let text: string;
    try {
      text = await this.llm.complete(
        {
          system:
            'You write short, plain, factual notes about a payment dispute for a merchant. Use only the facts in the case record. ' +
            'Never invent order numbers, tracking numbers, amounts, dates or refunds. Do not decide the outcome; describe the one given. ' +
            'The buyer message must be polite and make no promises beyond the stated outcome. ' +
            'Reply with only a JSON object: {"memo": string, "evidence_note": string, "buyer_message": string}.',
          user: JSON.stringify({ decision: input.decision, case_record: input.record, facts: input.facts }),
          maxTokens: 900,
        },
        this.visitorId,
      );
    } catch (error) {
      if (error instanceof LlmBudgetError || error instanceof LlmError) return { ...template, source: 'template (model output rejected)', rejectedBecause: [error.message] };
      throw error;
    }
    const parsed = extractJsonObject(text) as { memo?: unknown; evidence_note?: unknown; buyer_message?: unknown } | null;
    const fields = [parsed?.memo, parsed?.evidence_note, parsed?.buyer_message];
    if (!fields.every((f): f is string => typeof f === 'string' && f.trim() !== '' && f.length <= MAX_FIELD)) {
      return { ...template, source: 'template (model output rejected)', rejectedBecause: ['the model did not return the three required texts'] };
    }
    const [memo, evidenceNote, buyerMessage] = fields as [string, string, string];
    const corpus = groundingCorpus(input);
    const violations = [...new Set([memo, evidenceNote, buyerMessage].flatMap((t) => ungroundedTokens(t, corpus)))];
    if (violations.length > 0) {
      return { ...template, source: 'template (model output rejected)', rejectedBecause: violations.map((v) => `not in the case record: ${v}`) };
    }
    return { memo: `${memo}\n${input.decision.caveat}`, evidenceNote, buyerMessage, source: 'model' };
  }
}
