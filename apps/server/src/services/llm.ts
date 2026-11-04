import Anthropic from '@anthropic-ai/sdk';
import type { Clock } from '../clock';

/**
 * Language-model access, narrowed to what Warrant lets a model do: turn text into a closed enum, and write prose from facts
 * it is given. Models never see keys, never decide money, and every caller has a deterministic fallback. This module adds
 * the guard rails: a daily spend cap and a per-visitor run cap, so a public demo cannot run up a bill.
 */

export type ModelTier = 'main' | 'fast';

export interface LlmRequest {
  readonly system: string;
  readonly user: string;
  readonly maxTokens?: number;
  readonly tier?: ModelTier;
}

export interface LlmClient {
  complete(request: LlmRequest, visitorId?: string): Promise<string>;
}

export class LlmBudgetError extends Error {
  override readonly name = 'LlmBudgetError';
  constructor(
    message: string,
    readonly reason: 'daily_budget' | 'visitor_runs',
  ) {
    super(message);
  }
}

export class LlmError extends Error {
  override readonly name = 'LlmError';
}

/** The slice of the Anthropic SDK this module uses, so tests can supply a fake. */
export interface MessagesApi {
  create(params: {
    model: string;
    max_tokens: number;
    system: string;
    messages: Array<{ role: 'user'; content: string }>;
  }): Promise<{ content: Array<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number } }>;
}

export interface AnthropicLlmOptions {
  readonly api: MessagesApi;
  readonly model: string;
  readonly fastModel: string;
  readonly clock: Clock;
  readonly dailyBudgetUsd: number;
  readonly runsPerVisitor: number;
}

/** Rough list prices in USD per million tokens, used only to enforce the spend cap. Deliberately on the high side. */
const PRICE_PER_MTOK: Record<ModelTier, { input: number; output: number }> = {
  main: { input: 3, output: 15 },
  fast: { input: 1, output: 5 },
};

export function anthropicMessagesApi(apiKey: string): MessagesApi {
  const client = new Anthropic({ apiKey });
  return {
    create: async (params) => {
      const response = await client.messages.create(params);
      return { content: response.content.map((block) => (block.type === 'text' ? { type: 'text', text: block.text } : { type: block.type })), usage: response.usage };
    },
  };
}

export class AnthropicLlm implements LlmClient {
  private day = '';
  private spentUsd = 0;
  private readonly runs = new Map<string, number>();

  constructor(private readonly options: AnthropicLlmOptions) {}

  /** Spend so far today, in USD (an estimate from token counts). */
  get spentTodayUsd(): number {
    this.rollDay();
    return this.spentUsd;
  }

  async complete(request: LlmRequest, visitorId?: string): Promise<string> {
    this.rollDay();
    if (this.spentUsd >= this.options.dailyBudgetUsd) throw new LlmBudgetError('the daily model budget for this demo is used up', 'daily_budget');
    if (visitorId !== undefined) {
      const used = this.runs.get(visitorId) ?? 0;
      if (used >= this.options.runsPerVisitor) throw new LlmBudgetError('this visitor has used the demo\'s model runs for today', 'visitor_runs');
      this.runs.set(visitorId, used + 1);
    }
    const tier = request.tier ?? 'main';
    let response: Awaited<ReturnType<MessagesApi['create']>>;
    try {
      response = await this.options.api.create({
        model: tier === 'fast' ? this.options.fastModel : this.options.model,
        max_tokens: request.maxTokens ?? 1024,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      });
    } catch (error) {
      throw new LlmError(`the model request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    const price = PRICE_PER_MTOK[tier];
    this.spentUsd += ((response.usage?.input_tokens ?? 0) * price.input + (response.usage?.output_tokens ?? 0) * price.output) / 1_000_000;
    const text = response.content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');
    if (text.trim() === '') throw new LlmError('the model returned no text');
    return text;
  }

  private rollDay(): void {
    const today = new Date(this.options.clock.nowMs()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.spentUsd = 0;
      this.runs.clear();
    }
  }
}

/** Pull the first JSON object out of model text (models sometimes wrap it in prose or a code fence). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
