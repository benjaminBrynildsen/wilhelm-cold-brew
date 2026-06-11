// Postgres pool + schema bootstrap. Raw SQL (no ORM) — mirrors theodore-web.
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('[db] DATABASE_URL not set — the server will fail on DB access.');
}

// Render-managed Postgres needs TLS; allow self-signed in that managed context.
const ssl = /\brender\.com\b|\brender\b/.test(connectionString || '') ? { rejectUnauthorized: false } : undefined;

export const pool = new pg.Pool({
  connectionString,
  ssl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => console.error('[pg-pool] idle client error:', err.message));

export const q = (text, params) => pool.query(text, params);

export async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS journey_events (
      id          BIGSERIAL PRIMARY KEY,
      session_id  TEXT NOT NULL,
      event       TEXT NOT NULL,
      data        JSONB,
      ip_hash     TEXT,
      country     TEXT,
      user_agent  TEXT,
      page        TEXT,
      variant     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS je_page_created_idx ON journey_events (page, created_at);
    CREATE INDEX IF NOT EXISTS je_event_idx        ON journey_events (event);
    CREATE INDEX IF NOT EXISTS je_session_idx      ON journey_events (session_id);

    CREATE TABLE IF NOT EXISTS page_views (
      id            BIGSERIAL PRIMARY KEY,
      path          TEXT NOT NULL,
      referrer      TEXT,
      referrer_host TEXT,
      user_agent    TEXT,
      ip_hash       TEXT,
      country       TEXT,
      utm_source    TEXT,
      utm_medium    TEXT,
      utm_campaign  TEXT,
      utm_content   TEXT,
      utm_term      TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS pv_created_idx ON page_views (created_at);
    CREATE INDEX IF NOT EXISTS pv_path_idx    ON page_views (path);

    CREATE TABLE IF NOT EXISTS subscribers (
      id              BIGSERIAL PRIMARY KEY,
      email           TEXT NOT NULL UNIQUE,
      variant         TEXT,
      source          TEXT,
      ip_hash         TEXT,
      country         TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      unsubscribed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS sub_created_idx ON subscribers (created_at);

    CREATE TABLE IF NOT EXISTS email_blasts (
      id              BIGSERIAL PRIMARY KEY,
      subject         TEXT,
      body_html       TEXT,
      recipient_count INTEGER DEFAULT 0,
      sent_count      INTEGER DEFAULT 0,
      failed_count    INTEGER DEFAULT 0,
      status          TEXT DEFAULT 'draft',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at         TIMESTAMPTZ
    );

    -- IP hashes flagged internal (Ben's test devices) — excluded from all analytics.
    CREATE TABLE IF NOT EXISTS internal_ips (
      ip_hash    TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Columns added after launch (no-op if already present).
    ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS city   TEXT;
    ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS region TEXT;
    ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS country TEXT;
    ALTER TABLE page_views ADD COLUMN IF NOT EXISTS utm_content TEXT;
    ALTER TABLE page_views ADD COLUMN IF NOT EXISTS utm_term    TEXT;
    ALTER TABLE drops ADD COLUMN IF NOT EXISTS tasting_notes TEXT;
    ALTER TABLE drops ADD COLUMN IF NOT EXISTS origin    TEXT;
    ALTER TABLE drops ADD COLUMN IF NOT EXISTS varietal  TEXT;
    ALTER TABLE drops ADD COLUMN IF NOT EXISTS elevation TEXT;
    ALTER TABLE drops ADD COLUMN IF NOT EXISTS roast     TEXT;

    -- One row per email sent (welcome or blast) — powers open tracking via pixel.
    CREATE TABLE IF NOT EXISTS email_sends (
      id            BIGSERIAL PRIMARY KEY,
      token         TEXT UNIQUE NOT NULL,
      email         TEXT NOT NULL,
      kind          TEXT NOT NULL,             -- 'welcome' | 'blast'
      blast_id      BIGINT,
      sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      first_open_at TIMESTAMPTZ,
      opens         INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS es_blast_idx ON email_sends (blast_id);
    CREATE INDEX IF NOT EXISTS es_kind_idx  ON email_sends (kind);
    CREATE INDEX IF NOT EXISTS es_sent_idx  ON email_sends (sent_at);

    -- Weekly Friday Drops: each is a limited, priced batch of bottles.
    CREATE TABLE IF NOT EXISTS drops (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT,
      price_cents INTEGER NOT NULL,
      bottle_cap  INTEGER NOT NULL,
      opens_at    TIMESTAMPTZ,
      closes_at   TIMESTAMPTZ,
      status        TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | live | soldout | closed
      tasting_notes TEXT,
      origin        TEXT,
      varietal      TEXT,
      elevation     TEXT,
      roast         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS drops_status_idx ON drops (status);

    -- Orders against a drop. status: pending (checkout created) | paid | failed | refunded.
    CREATE TABLE IF NOT EXISTS orders (
      id                    BIGSERIAL PRIMARY KEY,
      drop_id               BIGINT,
      email                 TEXT,
      quantity              INTEGER NOT NULL DEFAULT 1,
      amount_total_cents    INTEGER,
      currency              TEXT DEFAULT 'usd',
      status                TEXT NOT NULL DEFAULT 'pending',
      stripe_session_id     TEXT UNIQUE,
      stripe_payment_intent TEXT,
      shipping_name         TEXT,
      shipping_address      JSONB,
      variant               TEXT,
      twclid                TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at               TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS orders_drop_idx   ON orders (drop_id);
    CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
  `);
  console.log('[db] schema ready');
}
