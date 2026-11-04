import type { Db } from './index';

/**
 * Ordered, append-only list of schema migrations. A migration that has been released is never edited; change the schema
 * with a new entry. `migrate` applies the missing ones inside one transaction and records them.
 */
export interface Migration {
  readonly id: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '001_registry_and_ledgers',
    sql: `
      CREATE TABLE platforms (
        id          text PRIMARY KEY,
        name        text NOT NULL,
        status      text NOT NULL CHECK (status IN ('active','suspended','revoked')),
        created_at  bigint NOT NULL
      );

      -- Public keys of wallets and agent platforms (docs/warrant-spec.md section 7).
      CREATE TABLE registry_keys (
        position           bigint GENERATED ALWAYS AS IDENTITY,
        kid                text PRIMARY KEY,
        kind               text NOT NULL CHECK (kind IN ('wallet','agent')),
        owner              text NOT NULL,
        platform_id        text REFERENCES platforms(id),
        public_key         text NOT NULL,
        status             text NOT NULL CHECK (status IN ('active','suspended','revoked')),
        valid_from         bigint NOT NULL,
        valid_to           bigint,
        status_changed_at  bigint,
        created_at         bigint NOT NULL
      );
      CREATE INDEX registry_keys_owner ON registry_keys(owner);

      -- Append-only, hash-chained log of issued cart warrant hashes and key events.
      CREATE TABLE transparency_log (
        chain_id    text NOT NULL,
        seq         integer NOT NULL,
        type        text NOT NULL,
        payload     jsonb NOT NULL,
        prev_hash   text NOT NULL,
        hash        text NOT NULL,
        created_at  bigint NOT NULL,
        PRIMARY KEY (chain_id, seq)
      );
      CREATE UNIQUE INDEX transparency_log_cart_jti
        ON transparency_log ((payload->>'cart_jti')) WHERE type = 'warrant_logged';

      -- Signed statements "the log had this head at this time", so a later rewrite is detectable.
      CREATE TABLE transparency_checkpoints (
        seq        integer PRIMARY KEY,
        head_hash  text NOT NULL,
        issued_at  bigint NOT NULL,
        jws        text NOT NULL
      );

      -- The audit ledger: one hash chain per order, mandate or dispute.
      CREATE TABLE ledger_entries (
        chain_id    text NOT NULL,
        seq         integer NOT NULL,
        type        text NOT NULL,
        payload     jsonb NOT NULL,
        prev_hash   text NOT NULL,
        hash        text NOT NULL,
        created_at  bigint NOT NULL,
        PRIMARY KEY (chain_id, seq)
      );
    `,
  },
  {
    id: '002_wallet',
    sql: `
      -- The human's side. One principal per visitor in the demo; the visitor id is a random token kept in the browser.
      CREATE TABLE principals (
        id             text PRIMARY KEY,
        visitor_id     text NOT NULL UNIQUE,
        display_name   text NOT NULL,
        payer_id_hash  text,
        created_at     bigint NOT NULL
      );

      CREATE TABLE mandates (
        jti               text PRIMARY KEY,
        principal_id      text NOT NULL REFERENCES principals(id),
        hash              text NOT NULL,
        payload           jsonb NOT NULL,
        jws               text NOT NULL,
        instruction_text  text NOT NULL,
        status            text NOT NULL CHECK (status IN ('active','revoked')),
        nbf               bigint NOT NULL,
        exp               bigint NOT NULL,
        created_at        bigint NOT NULL,
        revoked_at        bigint
      );
      CREATE INDEX mandates_principal ON mandates(principal_id);

      -- A cart the agent asked the wallet to show to the principal. "presented" is exactly what the screen shows.
      CREATE TABLE proposals (
        id              text PRIMARY KEY,
        mandate_jti     text NOT NULL REFERENCES mandates(jti),
        cart_jti        text NOT NULL UNIQUE,
        nonce           text NOT NULL,
        aud             text NOT NULL,
        proposed_by     text NOT NULL,
        cart            jsonb NOT NULL,
        cart_hash       text NOT NULL,
        presented       jsonb NOT NULL,
        presented_hash  text NOT NULL,
        status          text NOT NULL CHECK (status IN ('pending','approved','declined','expired')),
        expires_at      bigint NOT NULL,
        created_at      bigint NOT NULL,
        decided_at      bigint
      );
      CREATE INDEX proposals_mandate ON proposals(mandate_jti);

      CREATE TABLE consents (
        cart_jti        text PRIMARY KEY REFERENCES proposals(cart_jti),
        proposal_id     text NOT NULL UNIQUE REFERENCES proposals(id),
        mandate_jti     text NOT NULL,
        aud             text NOT NULL,
        cart_hash       text NOT NULL,
        presented_hash  text NOT NULL,
        approved_at     text NOT NULL,
        method          text NOT NULL,
        signature       text NOT NULL,
        created_at      bigint NOT NULL
      );
    `,
  },
  {
    id: '003_store_and_orders',
    sql: `
      CREATE TABLE settings (
        key    text PRIMARY KEY,
        value  jsonb NOT NULL
      );

      -- The merchant's own catalog: the prices the verifier trusts (V08), never the agent's.
      CREATE TABLE store_products (
        sku              text PRIMARY KEY,
        title            text NOT NULL,
        description      text NOT NULL,
        brand            text,
        category         text NOT NULL,
        image_url        text,
        price_cents      bigint NOT NULL CHECK (price_cents > 0),
        currency         text NOT NULL,
        available        boolean NOT NULL,
        merchant_domain  text NOT NULL,
        url              text NOT NULL,
        source           text NOT NULL,
        listing_hash     text NOT NULL,
        snapshot         jsonb NOT NULL,
        updated_at       bigint NOT NULL
      );

      -- Accepted cart warrants. Unique nonce and jti make a consent single-use (V05).
      CREATE TABLE warrants (
        cart_jti       text PRIMARY KEY,
        nonce          text NOT NULL UNIQUE,
        mandate_jti    text NOT NULL,
        mandate_hash   text NOT NULL,
        cart_hash      text NOT NULL,
        warrant_hash   text NOT NULL,
        principal_ref  text NOT NULL,
        platform       text NOT NULL,
        bundle         jsonb NOT NULL,
        received_at    bigint NOT NULL
      );
      CREATE INDEX warrants_received ON warrants(received_at);
      CREATE INDEX warrants_mandate ON warrants(mandate_jti);

      -- Per-mandate tally of accepted carts, updated in the same transaction as the nonce and jti (cumulative mandates).
      CREATE TABLE mandate_spend (
        mandate_jti  text PRIMARY KEY,
        total_cents  bigint NOT NULL CHECK (total_cents >= 0),
        item_count   bigint NOT NULL CHECK (item_count >= 0)
      );

      CREATE TABLE orders (
        id                    text PRIMARY KEY,
        cart_jti              text UNIQUE REFERENCES warrants(cart_jti),
        mandate_jti           text,
        paypal_order_id       text UNIQUE,
        capture_id            text UNIQUE,
        status                text NOT NULL CHECK (status IN ('pending_review','created','approved','captured','rejected','failed','cancelled')),
        verifier_mode         text NOT NULL,
        verification_outcome  text NOT NULL,
        verification          jsonb NOT NULL,
        total_cents           bigint NOT NULL,
        item_count            bigint NOT NULL,
        currency              text NOT NULL,
        lines                 jsonb NOT NULL,
        payer_id_hash         text,
        invoice_id            text,
        approval_url          text,
        note                  text,
        created_at            bigint NOT NULL,
        updated_at            bigint NOT NULL
      );
      CREATE INDEX orders_created ON orders(created_at);

      CREATE TABLE tracking (
        order_id         text PRIMARY KEY REFERENCES orders(id),
        carrier          text NOT NULL,
        tracking_number  text NOT NULL,
        status           text NOT NULL CHECK (status IN ('shipped','delivered')),
        promised_by      bigint,
        shipped_at       bigint NOT NULL,
        delivered_at     bigint,
        -- sku -> listing hash of what the store listed when it shipped (dispute fact F10)
        fulfilled_listings  jsonb NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE TABLE refunds (
        id            text PRIMARY KEY,
        order_id      text NOT NULL REFERENCES orders(id),
        capture_id    text NOT NULL,
        amount_cents  bigint NOT NULL,
        status        text NOT NULL,
        created_at    bigint NOT NULL
      );

      -- Every checkout call, including rejected ones, so the console can show what was turned away and why.
      CREATE TABLE checkout_attempts (
        id          text PRIMARY KEY,
        cart_jti    text,
        outcome     text NOT NULL,
        findings    jsonb NOT NULL,
        order_id    text,
        created_at  bigint NOT NULL
      );
      CREATE INDEX checkout_attempts_created ON checkout_attempts(created_at);

      CREATE TABLE webhook_events (
        paypal_event_id  text PRIMARY KEY,
        type             text NOT NULL,
        verified         boolean NOT NULL,
        payload          jsonb NOT NULL,
        received_at      bigint NOT NULL,
        processed_at     bigint,
        error            text
      );
    `,
  },
  {
    id: '004_disputes',
    sql: `
      CREATE TABLE disputes (
        paypal_dispute_id  text PRIMARY KEY,
        order_id           text REFERENCES orders(id),
        capture_id         text,
        reason             text NOT NULL,
        stage              text,
        status             text NOT NULL,
        amount_cents       bigint NOT NULL,
        currency           text NOT NULL,
        buyer_message      text,
        claim_type         text,
        claim_source       text,
        claim_conflict     boolean NOT NULL DEFAULT false,
        response_due_by    bigint,
        state              text NOT NULL CHECK (state IN ('received','awaiting_approval','responded','closed','escalated')),
        outcome_code       text,
        raw                jsonb NOT NULL,
        created_at         bigint NOT NULL,
        updated_at         bigint NOT NULL
      );
      CREATE INDEX disputes_order ON disputes(order_id);

      -- Every analysis run: the facts F1-F13 and the table decision, kept so a past ruling can be reproduced.
      CREATE TABLE dispute_facts (
        id            text PRIMARY KEY,
        dispute_id    text NOT NULL REFERENCES disputes(paypal_dispute_id),
        facts         jsonb NOT NULL,
        decision      jsonb NOT NULL,
        computed_at   bigint NOT NULL
      );
      CREATE INDEX dispute_facts_dispute ON dispute_facts(dispute_id, computed_at);

      CREATE TABLE dispute_actions (
        id               text PRIMARY KEY,
        dispute_id       text NOT NULL REFERENCES disputes(paypal_dispute_id),
        facts_id         text NOT NULL REFERENCES dispute_facts(id),
        outcome          text NOT NULL,
        rule             text NOT NULL,
        action_type      text NOT NULL,
        params           jsonb NOT NULL,
        memo             text NOT NULL,
        evidence_note    text NOT NULL,
        buyer_message    text NOT NULL,
        note_source      text NOT NULL,
        status           text NOT NULL CHECK (status IN ('proposed','executed','rejected','failed','superseded')),
        approved_by      text,
        paypal_response  jsonb,
        error            text,
        created_at       bigint NOT NULL,
        decided_at       bigint
      );
      CREATE INDEX dispute_actions_dispute ON dispute_actions(dispute_id, created_at);

      CREATE TABLE evidence_packets (
        id            text PRIMARY KEY,
        dispute_id    text NOT NULL REFERENCES disputes(paypal_dispute_id),
        action_id     text REFERENCES dispute_actions(id),
        file_name     text NOT NULL,
        content_type  text NOT NULL,
        sha256        text NOT NULL,
        size_bytes    bigint NOT NULL,
        content_b64   text NOT NULL,
        packet        jsonb NOT NULL,
        created_at    bigint NOT NULL
      );
      CREATE INDEX evidence_packets_dispute ON evidence_packets(dispute_id);
    `,
  },
  {
    id: '005_agent_chat',
    sql: `
      CREATE TABLE agent_sessions (
        id            text PRIMARY KEY,
        principal_id  text NOT NULL REFERENCES principals(id),
        mandate_jti   text REFERENCES mandates(jti),
        state         jsonb NOT NULL,
        created_at    bigint NOT NULL,
        updated_at    bigint NOT NULL
      );
      CREATE INDEX agent_sessions_principal ON agent_sessions(principal_id, created_at);

      CREATE TABLE agent_messages (
        id          text PRIMARY KEY,
        session_id  text NOT NULL REFERENCES agent_sessions(id),
        seq         integer NOT NULL,
        role        text NOT NULL CHECK (role IN ('user','assistant')),
        parts       jsonb NOT NULL,
        created_at  bigint NOT NULL,
        UNIQUE (session_id, seq)
      );
    `,
  },
  {
    id: '006_attempt_mandate',
    sql: `
      -- Which mandate a checkout attempt presented, so the console can tell shoppers' attempts from Dispute Lab runs.
      ALTER TABLE checkout_attempts ADD COLUMN mandate_jti text;
    `,
  },
];

export async function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at bigint NOT NULL)');
  return db.transaction(async (tx) => {
    // One migrator at a time across instances.
    await tx.query('SELECT pg_advisory_xact_lock(727274)');
    const done = new Set((await tx.query<{ id: string }>('SELECT id FROM schema_migrations')).map((r) => r.id));
    const applied: string[] = [];
    for (const migration of migrations) {
      if (done.has(migration.id)) continue;
      for (const statement of splitStatements(migration.sql)) await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)', [migration.id, Math.floor(Date.now() / 1000)]);
      applied.push(migration.id);
    }
    return applied;
  });
}

/** Split a migration into statements on `;` at the end of a line. Migrations here contain no dollar-quoted bodies. */
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.length > 0);
}
