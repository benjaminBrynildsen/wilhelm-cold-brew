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

    -- Email addresses flagged internal/test — excluded from email-tab metrics
    -- (welcome open rate, per-kind open rates, blast opens). Stored lowercased.
    -- Any address containing 'test' is also auto-excluded by the queries, so the
    -- proofing addresses Claude used don't need to be listed here individually.
    CREATE TABLE IF NOT EXISTS internal_emails (
      email      TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO internal_emails (email) VALUES
      ('benbrynildsen5757@gmail.com'),
      ('ben@wilhelmcoldbrew.com')
    ON CONFLICT (email) DO NOTHING;

    -- Which split-test arms are currently LIVE. The /drink page reads the enabled
    -- 'image' arms to decide what to randomize among, so versions can be toggled
    -- or isolated from the admin without a deploy. Seeded with all three on.
    CREATE TABLE IF NOT EXISTS split_arms (
      test_id  TEXT NOT NULL,
      arm_key  TEXT NOT NULL,
      enabled  BOOLEAN NOT NULL DEFAULT true,
      sort     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (test_id, arm_key)
    );
    INSERT INTO split_arms (test_id, arm_key, enabled, sort) VALUES
      ('image','cigars',true,0),
      ('image','barrel',true,1),
      ('image','bottles',true,2),
      ('background','dark',true,0),
      ('background','light',true,1),
      ('headline','on-the-list',true,0),
      ('headline','sold-out-13',true,1),
      ('headline','sold-out-list',true,2)
    ON CONFLICT (test_id, arm_key) DO NOTHING;

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
    -- First-party ad attribution on signups (which ad/campaign drove each subscriber).
    ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS twclid       TEXT;
    ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS utm_source   TEXT;
    ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS utm_medium   TEXT;
    ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
    ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS utm_content  TEXT;
    ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS utm_term     TEXT;
    -- Fulfillment: set when an order's label has been pulled into Pirate Ship, so
    -- the export only ever shows what still needs to ship.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;
    -- Tracking, imported from Pirate Ship. ship_notified_at guards against re-sending
    -- the "your order shipped" email when the same export is uploaded twice.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number  TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_carrier TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_notified_at TIMESTAMPTZ;

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

    -- Editable app settings (key → JSON). Used for the shipping-email template.
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('[db] schema ready');
}
