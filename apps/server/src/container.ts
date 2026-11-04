import { Channel3Catalog, FixtureCatalog, type Catalog } from '@warrant/catalog';
import { merchantAudience } from '@warrant/warrant';
import { systemClock, ulidIds, type Clock, type Ids } from './clock';
import type { Config } from './config';
import { openDb, type Db } from './db';
import { migrate } from './db/migrations';
import { loadServerKeys, type ServerKeys } from './keys';
import { ShoppingAgent } from './services/agent';
import { AgentPlatform } from './services/agent-platform';
import { registerIdentities } from './services/bootstrap';
import { LlmClaimExtractor, RulesClaimExtractor, type ClaimExtractor } from './services/claims';
import { DisputeService } from './services/disputes';
import { LlmIntentParser, LlmProductPicker, RulesIntentParser, RulesProductPicker, type IntentParser, type ProductPicker } from './services/intent';
import { AnthropicLlm, anthropicMessagesApi, type LlmClient } from './services/llm';
import { MerchantService } from './services/merchant';
import { LlmNoteWriter, TemplateNoteWriter, type NoteWriter } from './services/notes';
import { attachSimulatorState } from './services/simulator-state';
import { createPayPalGateway, type PayPalGateway } from './services/paypal';
import { RegistryService } from './services/registry';
import { StoreService } from './services/store';
import { VerificationService } from './services/verification';
import { WalletService } from './services/wallet';
import { simulatorSink } from './services/webhooks';

/** Every service, wired together once. The HTTP layer, the Dispute Lab and the evaluation runner all use this. */
export interface Container {
  readonly config: Config;
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly keys: ServerKeys;
  readonly registry: RegistryService;
  readonly store: StoreService;
  readonly wallet: WalletService;
  readonly paypal: PayPalGateway;
  readonly merchant: MerchantService;
  readonly disputes: DisputeService;
  readonly platform: AgentPlatform;
  readonly shopper: ShoppingAgent;
  readonly verification: VerificationService;
  readonly catalog: Catalog;
  /** The model client, or null in fixtures mode. */
  readonly llm: LlmClient | null;
  close(): Promise<void>;
}

export interface ContainerOverrides {
  readonly clock?: Clock;
  readonly ids?: Ids;
  readonly db?: Db;
  readonly catalog?: Catalog;
  readonly llm?: LlmClient | null;
  readonly claims?: ClaimExtractor;
  readonly notes?: NoteWriter;
  readonly intents?: IntentParser;
  readonly picker?: ProductPicker;
  /** Keep generated development keys in `<dataDir>/dev-keys.json`. Default: only for a local PGlite database. */
  readonly persistKeys?: boolean;
}

export async function createContainer(config: Config, overrides: ContainerOverrides = {}): Promise<Container> {
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? ulidIds(clock);
  const local = config.databaseUrl === null && config.nodeEnv !== 'test';
  const ownDb = overrides.db === undefined;
  const db = overrides.db ?? (await openDb({ databaseUrl: config.databaseUrl, dataDir: local ? config.dataDir : null }));
  await migrate(db);

  const keys = loadServerKeys(config, { persist: overrides.persistKeys ?? local });
  const registry = new RegistryService(db, clock, keys.registry);
  await registerIdentities(registry, keys, clock);

  const live = config.mode === 'live';
  const llm: LlmClient | null =
    overrides.llm !== undefined
      ? overrides.llm
      : live && config.anthropic.apiKey !== null
        ? new AnthropicLlm({ api: anthropicMessagesApi(config.anthropic.apiKey), model: config.anthropic.model, fastModel: config.anthropic.fastModel, clock, dailyBudgetUsd: config.llmDailyBudgetUsd, runsPerVisitor: config.llmRunsPerVisitor })
        : null;
  const catalog: Catalog = overrides.catalog ?? (live && config.channel3ApiKey !== null ? new Channel3Catalog({ apiKey: config.channel3ApiKey }) : new FixtureCatalog());

  const store = new StoreService(db, clock);
  if (!live) await store.seedFixtures();
  const wallet = new WalletService({ db, clock, ids, key: keys.wallet, merchants: new Map([[merchantAudience(config.paypal.merchantId), config.merchantName]]) });
  const paypal = createPayPalGateway(config, clock);
  // A database that outlives the process (a local folder or Postgres) also holds what the simulator knows, so restarts are safe.
  const simulatorState = ownDb && config.nodeEnv !== 'test' && paypal.simulator !== null ? await attachSimulatorState(db, paypal.simulator) : null;
  const merchant = new MerchantService({ db, clock, ids, config, registry, wallet, store, paypal });
  const disputes = new DisputeService({
    db,
    clock,
    ids,
    config,
    registry,
    wallet,
    store,
    merchant,
    paypal,
    claims: overrides.claims ?? (llm === null ? new RulesClaimExtractor() : new LlmClaimExtractor(llm)),
    notes: overrides.notes ?? (llm === null ? new TemplateNoteWriter() : new LlmNoteWriter(llm)),
  });
  merchant.onDisputeEvent((event) => disputes.handleEvent(event));
  paypal.simulator?.setWebhookSink(simulatorSink(merchant));

  const platform = new AgentPlatform({ clock, key: keys.agent, wallet });
  const shopper = new ShoppingAgent({
    db,
    clock,
    ids,
    config,
    catalog,
    store,
    wallet,
    platform,
    merchant,
    intents: overrides.intents ?? (llm === null ? new RulesIntentParser() : new LlmIntentParser(llm)),
    picker: overrides.picker ?? (llm === null ? new RulesProductPicker() : new LlmProductPicker(llm)),
    agentKid: keys.agent.kid,
  });
  const verification = new VerificationService({ db, clock, registry, merchant, disputes });

  return {
    config,
    db,
    clock,
    ids,
    keys,
    registry,
    store,
    wallet,
    paypal,
    merchant,
    disputes,
    platform,
    shopper,
    verification,
    catalog,
    llm,
    close: async () => {
      await simulatorState?.flush();
      if (ownDb) await db.close();
    },
  };
}
