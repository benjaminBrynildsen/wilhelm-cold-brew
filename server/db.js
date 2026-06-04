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
  `);
  console.log('[db] schema ready');
}
