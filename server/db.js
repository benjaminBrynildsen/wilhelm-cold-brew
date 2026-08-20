// Postgres pool + schema bootstrap. Raw SQL (no ORM) — mirrors theodore-web.
import pg from 'pg';
import { DISPOSABLE_DOMAINS } from './util.js';

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
    -- Time-only scans (overview "sessions, all pages") can't use the
    -- (page, created_at) index; give them a direct one.
    CREATE INDEX IF NOT EXISTS je_created_idx      ON journey_events (created_at);

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
    CREATE INDEX IF NOT EXISTS pv_ip_created_idx ON page_views (ip_hash, created_at);

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
      ('image','reviews',false,3),  -- review-screenshot two-up; ships paused, flip live in admin
      ('image','minimal',false,4),  -- no bullets, big countdown; ships paused, flip live in admin
      ('image','video',false,5),    -- muted pour-loop video; ships paused, flip live in admin
      ('background','dark',true,0),
      ('background','light',true,1),
      ('headline','on-the-list',true,0),
      ('headline','sold-out-13',true,1),
      ('headline','sold-out-5',true,2),
      ('headline','sold-out-list',true,3)
    ON CONFLICT (test_id, arm_key) DO NOTHING;

    -- Columns added after launch (no-op if already present).
    ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS city   TEXT;
    ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS region TEXT;
    ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS country TEXT;
    ALTER TABLE page_views ADD COLUMN IF NOT EXISTS utm_content TEXT;
    ALTER TABLE page_views ADD COLUMN IF NOT EXISTS utm_term    TEXT;
    -- First-party ad attribution on signups (which ad/campaign drove each subscriber).
    ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS twclid       TEXT;
    ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS utm_source   TEXT;
    ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS utm_medium   TEXT;
    ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
    ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS utm_content  TEXT;
    ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS utm_term     TEXT;
    -- Signup timing (ms from page-open to submit) on EVERY signup, not just the
    -- flagged fast ones — so the Bot Catcher can show the real human distribution
    -- and prove the sub-2s challenge sits well below how long real people take.
    ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS elapsed_ms   INTEGER;
    -- Manual archive (soft delete) — set when Ben removes someone from the list.
    -- Distinct from unsubscribed_at (their opt-out); archived rows are excluded
    -- from every active query but kept for restore/audit.
    ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS archived_at  TIMESTAMPTZ;
    -- Soft-challenge attempts: one row each time the "one more tap" modal is shown
    -- (an impossibly-fast first submit). confirmed flips true when they tap again
    -- and the real signup lands. Rows left confirmed=false are the ones that BAILED
    -- after seeing the challenge — surfaced in the Bot Catcher as deterred bots.
    -- No welcome/alert ever fires from this table; it's tracking-only.
    CREATE TABLE IF NOT EXISTS challenge_attempts (
      id         BIGSERIAL PRIMARY KEY,
      session_id TEXT,
      email      TEXT,
      elapsed_ms INTEGER,
      ip_hash    TEXT,
      country    TEXT,
      variant    TEXT,
      confirmed  BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS challenge_created_idx ON challenge_attempts (created_at);
    CREATE INDEX IF NOT EXISTS challenge_session_idx ON challenge_attempts (session_id);
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
    -- Post-launch drop columns (kept AFTER the CREATE so a fresh DB bootstraps clean).
    ALTER TABLE drops ADD COLUMN IF NOT EXISTS tasting_notes TEXT;
    ALTER TABLE drops ADD COLUMN IF NOT EXISTS origin    TEXT;
    ALTER TABLE drops ADD COLUMN IF NOT EXISTS varietal  TEXT;
    ALTER TABLE drops ADD COLUMN IF NOT EXISTS elevation TEXT;
    ALTER TABLE drops ADD COLUMN IF NOT EXISTS roast     TEXT;

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
    -- Fulfillment: set when an order's label has been pulled into Pirate Ship, so
    -- the export only ever shows what still needs to ship.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;
    -- Tracking, imported from Pirate Ship. ship_notified_at guards against re-sending
    -- the "your order shipped" email when the same export is uploaded twice.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number  TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_carrier TEXT;
    -- Split shipments (one box per bottle) carry several tracking numbers; the
    -- full list lives here as [{tracking, carrier}, …] while tracking_number
    -- keeps the first for anything that expects a single value.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_numbers JSONB;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_notified_at TIMESTAMPTZ;
    -- USPS delivery tracking (Shipping tab). delivered_at is set once the carrier
    -- reports delivery; tracking_status is the latest human-readable status;
    -- tracking_checked_at throttles how often we re-poll USPS per package.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at        TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_status     TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_checked_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS orders_delivery_idx ON orders (drop_id, delivered_at);

    -- Autopilot bookkeeping on split arms: set when the bandit turns an arm off
    -- (vs a manual pause). Re-enabling an arm clears both.
    ALTER TABLE split_arms ADD COLUMN IF NOT EXISTS auto_paused_at TIMESTAMPTZ;
    ALTER TABLE split_arms ADD COLUMN IF NOT EXISTS auto_reason    TEXT;
    -- Set when an arm is manually (re-)enabled: the kill rule only counts
    -- evidence gathered after this, so a revived arm gets a genuine fresh shot.
    ALTER TABLE split_arms ADD COLUMN IF NOT EXISTS revived_at     TIMESTAMPTZ;

    -- Autopilot daily decision log: what each arm did (landed/joined, Central
    -- day) and the traffic weight the bandit gave it. One row per day/test/arm,
    -- refreshed through the day — the admin's daily results view reads this.
    CREATE TABLE IF NOT EXISTS bandit_log (
      day        TEXT NOT NULL,           -- YYYY-MM-DD (America/Chicago)
      test_id    TEXT NOT NULL,
      arm_key    TEXT NOT NULL,
      weight     REAL,
      landed     INTEGER NOT NULL DEFAULT 0,
      joined     INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (day, test_id, arm_key)
    );

    -- Manually pinned split-test combinations: a full recipe (image × background
    -- × headline) served as a unit to pin_pct % of new visitors. Set from the
    -- admin's Best combinations table; the autopilot's champion pool works on top.
    CREATE TABLE IF NOT EXISTS split_combos (
      image      TEXT NOT NULL,
      bg         TEXT NOT NULL,
      hl         TEXT NOT NULL,
      pin_pct    INTEGER NOT NULL,          -- 1..100, share of NEW-visitor traffic
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (image, bg, hl)
    );

    -- Customer email conversations, synced from the mailbox over IMAP (see
    -- server/inbox.js). One row per message, keyed to the customer's address;
    -- the Thank-you tab renders these as per-customer conversation cards.
    CREATE TABLE IF NOT EXISTS email_messages (
      id             BIGSERIAL PRIMARY KEY,
      message_id     TEXT UNIQUE,             -- RFC Message-ID (dedupe across syncs)
      customer_email TEXT NOT NULL,           -- counterpart address, lowercased
      direction      TEXT NOT NULL,           -- 'in' (from customer) | 'out' (our reply)
      subject        TEXT,
      body           TEXT,
      sent_at        TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS em_customer_idx ON email_messages (customer_email, sent_at);

    -- Which orders already got a handwritten thank-you card.
    CREATE TABLE IF NOT EXISTS thankyou_cards (
      order_id   BIGINT PRIMARY KEY,
      written_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Customer portal ("The Cellar"): single-use magic-link login tokens.
    CREATE TABLE IF NOT EXISTS portal_tokens (
      token      TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at    TIMESTAMPTZ
    );
    -- One shareable referral code per member. Signups it brings arrive tagged
    -- utm_source=referral & utm_campaign=<code>, so counting needs no new columns.
    CREATE TABLE IF NOT EXISTS referral_codes (
      code       TEXT PRIMARY KEY,
      email      TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Ad creative registry for the admin "Ad Fit" tab. name matches the ad URL's
    -- utm_content, so traffic/conversion data joins to the creative. covers is the
    -- list of knowledge-point keys the ad itself communicates (see adfit config).
    CREATE TABLE IF NOT EXISTS ads (
      id         BIGSERIAL PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      post_text  TEXT,
      image_data TEXT,                        -- data: URL of a downscaled creative
      covers     JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Link to the live ad on X, so the Traffic channel table can open it directly.
    ALTER TABLE ads ADD COLUMN IF NOT EXISTS x_url TEXT;

    -- Editable app settings (key → JSON). Used for the shipping-email template.
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Loyalty points ledger. Every earn/spend is one immutable row; balances are
    -- derived (SUM of delta = spendable balance; SUM of positive delta = lifetime
    -- earned, which drives permanent status like the Pre-Order privilege). The
    -- unique key makes awards idempotent — one 'purchase' row per order, one
    -- 'review' row per (member, batch) — so re-processing never double-awards.
    CREATE TABLE IF NOT EXISTS point_events (
      id         BIGSERIAL PRIMARY KEY,
      email      TEXT NOT NULL,                 -- normalized (lower) member email
      delta      INTEGER NOT NULL,              -- + earn, - spend
      reason     TEXT NOT NULL,                 -- purchase | review | recipe_rating | recipe_add | redeem_*
      ref_type   TEXT NOT NULL DEFAULT '',      -- order | drop | recipe | redemption
      ref_id     TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (email, reason, ref_type, ref_id)
    );
    CREATE INDEX IF NOT EXISTS point_events_email_idx ON point_events (email);

    -- Batch reviews (private for now — for points + admin eyes, not shown publicly).
    -- flavors is the list of notes the member tapped on the tasting wheel. One
    -- review per member per batch.
    CREATE TABLE IF NOT EXISTS reviews (
      id         BIGSERIAL PRIMARY KEY,
      email      TEXT NOT NULL,
      drop_id    BIGINT REFERENCES drops(id) ON DELETE CASCADE,
      rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      body       TEXT,
      flavors    JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (email, drop_id)
    );
    CREATE INDEX IF NOT EXISTS reviews_drop_idx ON reviews (drop_id);

    -- WebAuthn / passkey credentials (Face ID / Touch ID admin sign-in). One shared
    -- admin, so every row is a registered device for that admin.
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id           TEXT PRIMARY KEY,          -- credential ID (base64url)
      public_key   BYTEA NOT NULL,
      counter      BIGINT NOT NULL DEFAULT 0,
      transports   TEXT,                      -- JSON array
      label        TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ
    );
  `);
  // Canonical email for cross-table identity matching (order ↔ subscriber).
  // People sign up as ryan.kiley@gmail.com and check out via autofill as
  // ryankiley@gmail.com or ryan.kiley+shop@gmail.com — same inbox, different
  // string. Gmail ignores dots and +tags (and googlemail = gmail); +tags are
  // provider-side aliases everywhere. Truly different addresses (work vs
  // @me.com relay) can't be unified, so buckets stay honest about "no match".
  await q(`
    CREATE OR REPLACE FUNCTION norm_email(t TEXT) RETURNS TEXT
    IMMUTABLE RETURNS NULL ON NULL INPUT LANGUAGE sql AS $fn$
      SELECT CASE WHEN split_part(lower(btrim(t)), '@', 2) IN ('gmail.com', 'googlemail.com')
        THEN replace(split_part(split_part(lower(btrim(t)), '@', 1), '+', 1), '.', '') || '@gmail.com'
        ELSE split_part(split_part(lower(btrim(t)), '@', 1), '+', 1) || '@' || split_part(lower(btrim(t)), '@', 2)
        END
    $fn$;

    -- The Orders dashboard matches orders to subscribers through norm_email() on
    -- BOTH sides. Without a functional index that defeats any plain email index,
    -- so each paid order seq-scanned the whole subscriber list — the Orders tab
    -- took ~20s+ once the list grew. Index norm_email(email) on both tables.
    -- (norm_email is IMMUTABLE, so it's indexable.)
    CREATE INDEX IF NOT EXISTS sub_norm_email_idx    ON subscribers (norm_email(email));
    CREATE INDEX IF NOT EXISTS orders_norm_email_idx ON orders      (norm_email(email));
  `);
  console.log('[db] schema ready');

  // Adopt orphaned sold-out demand votes. A bug in /api/drop/current left
  // "would've bought" votes untagged (dropId null) whenever next week's
  // scheduled batch already existed — the votes were recorded but invisible
  // in the admin's per-drop demand count. Re-attribute each untagged vote to
  // the batch most recently OPENED at the moment it was cast. Idempotent
  // (only touches rows still missing a dropId), so it's safe on every boot.
  try {
    const r = await q(`
      UPDATE journey_events je
         SET data = jsonb_set(COALESCE(je.data, '{}'::jsonb), '{dropId}',
               to_jsonb((SELECT d.id::text FROM drops d
                          WHERE d.status <> 'scheduled' AND d.opens_at IS NOT NULL
                            AND d.opens_at <= je.created_at
                          ORDER BY d.opens_at DESC LIMIT 1)))
       WHERE je.event = 'soldout_demand'
         AND (je.data->>'dropId') IS NULL
         AND EXISTS (SELECT 1 FROM drops d
                      WHERE d.status <> 'scheduled' AND d.opens_at IS NOT NULL
                        AND d.opens_at <= je.created_at)`);
    if (r.rowCount) console.log(`[db] adopted ${r.rowCount} untagged sold-out vote(s)`);
  } catch (e) { console.warn('[db] demand-vote backfill failed (non-fatal):', e?.message || e); }

  // Scrub synthetic probe signups. The prod-check workflow used to insert
  // @example.com addresses (reserved domain — no real customer possible), which
  // ticked the signup badge and inflated list counts. The subscribe endpoint no
  // longer stores them; this removes the ones already recorded. Idempotent.
  try {
    const r = await q(`DELETE FROM subscribers WHERE email LIKE '%@example.com'`);
    if (r.rowCount) console.log(`[db] removed ${r.rowCount} probe signup(s)`);
  } catch (e) { console.warn('[db] probe-signup cleanup failed (non-fatal):', e?.message || e); }

  // Bot Catcher: suspicious signups are FLAGGED for review, never rejected —
  // Ben decides. bot_flag holds comma-joined reasons ('honeypot','instant',
  // 'dotted'), or 'cleared' once he marks one as real. bot_seen_at drives the
  // red unseen badge. The backfill flags the dot-scattered gmail pattern
  // (dots between nearly every character — a bot alias trick, ≥4 dots is far
  // beyond any real first.middle.last) on rows recorded before the feature;
  // it skips 'cleared' rows so his judgements stick across boots.
  try {
    await q(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS bot_flag TEXT;
             ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS bot_seen_at TIMESTAMPTZ;`);
    const r = await q(
      `UPDATE subscribers SET bot_flag = 'dotted'
        WHERE bot_flag IS NULL
          AND split_part(email, '@', 2) IN ('gmail.com', 'googlemail.com')
          AND LENGTH(split_part(email, '@', 1)) - LENGTH(REPLACE(split_part(email, '@', 1), '.', '')) >= 4`);
    if (r.rowCount) console.log(`[db] flagged ${r.rowCount} dot-scattered signup(s) for the Bot Catcher`);

    // Retroactive cross-check of the past 3 months. Signups predating the
    // honeypot/timing signals only expose what's stored — the address and the
    // signup clustering — so we use two data-only heuristics, both flag-for-
    // review (Ben clears any false positive), idempotent (bot_flag IS NULL only):
    //   disposable — a throwaway/temp-mail domain no real customer uses.
    const disp = await q(
      `UPDATE subscribers SET bot_flag = 'disposable'
        WHERE bot_flag IS NULL
          AND created_at > now() - interval '3 months'
          AND lower(split_part(email, '@', 2)) = ANY($1)`, [[...DISPOSABLE_DOMAINS]]);
    if (disp.rowCount) console.log(`[db] flagged ${disp.rowCount} disposable-domain signup(s) for the Bot Catcher`);

    //   ip-burst — 5+ signups from one device (ip_hash) inside 10 minutes: a
    //   machine-gun burst no group of real people produces, even on a drop day.
    //   Internal test IPs excluded; window kept tight so mobile-carrier NAT
    //   (many real phones sharing one IP) can't trip it.
    const burst = await q(
      `UPDATE subscribers SET bot_flag = 'ip-burst'
        WHERE bot_flag IS NULL
          AND created_at > now() - interval '3 months'
          AND ip_hash IN (
            SELECT ip_hash FROM subscribers
             WHERE ip_hash IS NOT NULL
               AND ip_hash NOT IN (SELECT ip_hash FROM internal_ips)
               AND created_at > now() - interval '3 months'
             GROUP BY ip_hash
            HAVING COUNT(*) >= 5 AND (MAX(created_at) - MIN(created_at)) < interval '10 minutes')`);
    if (burst.rowCount) console.log(`[db] flagged ${burst.rowCount} rapid-burst signup(s) for the Bot Catcher`);
  } catch (e) { console.warn('[db] bot-flag backfill failed (non-fatal):', e?.message || e); }
}
