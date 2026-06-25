# Email platform roadmap — build our own mini-Mailchimp (Postmark-backed)

> Deferred roadmap, captured 2026-06-25. The pre-drop fixes (duplicate-a-drop and
> unsubscribe visibility) shipped separately; this is the larger "own our sending
> infrastructure" effort to do after.

## Why we have a sending limit and Mailchimp doesn't

Gmail is a *mailbox*, not bulk-sending infrastructure. Google rate-limits every
account (~2,000/day, tight burst caps) because any account could be compromised,
and we're borrowing Google's general-purpose reputation with **no domain
authentication** of our own. Mailchimp / Postmark / SES run dedicated mail fleets
with years of IP reputation, they authenticate *your* domain (SPF/DKIM/DMARC), and
they get ISP feedback loops (instant bounce/complaint signals). We don't rebuild
that — we **rent the sending backbone** from a transactional email API and own the
app layer on top.

Wilhelm is already ~70% of a mini-Mailchimp: list management, a visual block
composer with live preview, variant/segment targeting, blast history, open
tracking, unsubscribe + one-click headers, CSV/audience exports, three resend
modes. What's missing is (a) the sending backbone, (b) domain auth, and (c)
production features (bounce/complaint suppression, click tracking, scheduling,
templates).

**Provider = Postmark** (best out-of-box deliverability, native click tracking,
automatic bounce/complaint suppression, simple JSON webhooks, no AWS/SNS plumbing;
at ~1k emails/mo the cost vs SES is a few dollars). A clean transport abstraction
keeps **SES as a cheap drop-in escape hatch** if cost ever bites at scale.

## Architecture: provider abstraction

All sending already funnels through `server/mailer.js` (5 send functions +
`mailReady`); **no call site builds messages** (`ingest.js`, `checkout.js`,
`admin.js` only call the exported functions). That makes the swap safe and local.

```
server/providers/postmark.js   — wraps the official `postmark` ServerClient (SDK, not SMTP)
server/providers/smtp.js       — the existing nodemailer/Gmail transporter, moved here verbatim (fallback / SES-later)
server/providers/index.js      — selectProvider() reads EMAIL_PROVIDER (default 'postmark'); falls back to smtp if unconfigured
```

Interface each provider implements:
- `sendMessage({from,to,subject,html,text,headers,stream}) -> {messageId, raw}`
- `sendBatch(messages[]) -> [{to, ok, messageId?, error?, blocked?}]` (Postmark batch endpoint, 500/call; SMTP omits it and the mailer loops)
- `isProviderBlock(err) -> bool` (Postmark keys on HTTP 429 / ErrorCodes 401/405/429/5xx; SMTP keeps the Gmail 421/454 detector)
- `ready() -> bool`

`mailer.js` keeps all 5 exported signatures and the provider-agnostic helpers
unchanged (`mkToken`, `recordSend`, `finalize`/pixel, `blastFooter`,
`unsubUrl`/`unsubHeaders`, `htmlToText`). It delegates the send and captures `messageId`.

**Streams:** welcome / order / internal alerts → Postmark **Transactional**;
blasts (`sendBulk`) → **Broadcast**. Separating them protects transactional
deliverability if a blast draws complaints.

**Tracking split:** keep our **own open pixel** as source of truth and set Postmark
`TrackOpens: false` (avoid double-counting). Enable Postmark `TrackLinks:
'HtmlAndText'` for **clicks** (no redirector of our own). Clicks arrive via webhook
keyed on the stored message id.

## Phase 0 — Deliverability foundation (DNS auth) — highest leverage, ~0 code

In Postmark add domain `wilhelmcoldbrew.com`; add the generated records in
**Squarespace DNS**:
1. **DKIM** (CNAME/TXT) — signs mail so receivers verify it's from your domain.
2. **Return-Path / custom bounce domain** (CNAME `pm-bounces` → `pm.mtasv.net`) — DMARC alignment + bounce routing.
3. **SPF** (TXT root: `v=spf1 include:spf.mtasv.net ~all`; merge — only one allowed) — authorizes Postmark to send.
4. **DMARC** (TXT `_dmarc`: start `v=DMARC1; p=none; rua=mailto:dmarc@wilhelmcoldbrew.com; fo=1`) — monitor, then tighten to quarantine/reject.

## Phase 1 — Schema (additive, idempotent, in `ensureSchema()` of `server/db.js`)

```sql
ALTER TABLE email_sends  ADD COLUMN IF NOT EXISTS provider            TEXT;
ALTER TABLE email_sends  ADD COLUMN IF NOT EXISTS provider_message_id TEXT;  -- canonical (Postmark MessageID)
CREATE INDEX IF NOT EXISTS es_pmid_idx ON email_sends (provider_message_id);
ALTER TABLE email_sends  ADD COLUMN IF NOT EXISTS clicks         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_sends  ADD COLUMN IF NOT EXISTS first_click_at TIMESTAMPTZ;
ALTER TABLE email_blasts ADD COLUMN IF NOT EXISTS scheduled_at   TIMESTAMPTZ;
ALTER TABLE email_blasts ADD COLUMN IF NOT EXISTS target_variant TEXT;   -- NULL=everyone, '(none)' sentinel
ALTER TABLE email_blasts ADD COLUMN IF NOT EXISTS target_list    TEXT;
CREATE INDEX IF NOT EXISTS eb_sched_idx ON email_blasts (status, scheduled_at);
CREATE TABLE IF NOT EXISTS suppressions (
  email TEXT PRIMARY KEY, reason TEXT NOT NULL,   -- hard_bounce | spam_complaint | manual | unsubscribe
  source TEXT, message_id TEXT, detail TEXT, raw JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS email_templates (
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, subject TEXT, body_html TEXT, blocks JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
```
`status` is free-text, so the new `'scheduled'` value needs no migration.

## Phase 2 — Transport swap (removes the limit)

- Add `postmark` to `package.json`. Build `server/providers/{postmark,smtp,index}.js`. Move the current transporter + Gmail `isProviderBlock` into `smtp.js`.
- Refactor `mailer.js`: `const provider = selectProvider()`; `mailReady = () => provider.ready()`; each `transporter.sendMail(...)` → `provider.sendMessage({...stream})`; capture `messageId`.
- Extend `recordSend(token, email, kind, blastId, messageId, provider)` to write `provider` + `provider_message_id` (new params default safely).
- Rewrite `sendBulk` to chunk recipients (≤500) through `provider.sendBatch`, preserving per-recipient token + `finalize(html + blastFooter(token), token)` + `unsubHeaders`, the `onProgress` callback, record-only-on-success, and the **stop-on-provider-block** → `{sent, failed, unsent, stopped}` accounting the `'unsent'` resend mode depends on.
- Env: `EMAIL_PROVIDER`, `POSTMARK_SERVER_TOKEN` (secret), `POSTMARK_STREAM_TRANSACTIONAL` (default `outbound`), `POSTMARK_STREAM_BROADCAST` (default `broadcast`). Add to `.env.local` + `render.yaml`.
- **No call-site changes.**

## Phase 3 — Safety layer (bounce / complaint / suppression)

- New `server/webhooks.js` → `mountWebhooks(app)`, route `POST /api/postmark/webhook`, mounted after `express.json()`, gated by **HTTP Basic auth** (`POSTMARK_WEBHOOK_SECRET` in the webhook URL). Public, NOT behind `requireAdmin`. Always returns 200; idempotent via `ON CONFLICT (email) DO NOTHING`.
- Handle by `RecordType`: **Bounce** (only HardBounce/Inactive → suppress; ignore soft/transient), **SpamComplaint** (suppress + set `unsubscribed_at`), **SubscriptionChange**, and **Open**/**Click** (update `email_sends` by `provider_message_id`).
- Add `EXCL_SUP = "AND LOWER(email) NOT IN (SELECT email FROM suppressions)"` and append to every recipient query (send/variant, all three resend modes, the draft count) + filter pasted custom lists (with `force` override).
- `isSuppressed(email)` helper in `mailer.js`; gate `sendWelcome` (let order receipts through). Pre-filter the `sendBulk` array once via `WHERE email = ANY($1)`.
- Unsubscribe handler also writes a `suppressions` row (`reason='unsubscribe'`).
- Admin UI: suppression counts by reason, recent bounces/complaints table, manual add/remove.

## Phase 4 — Campaign features

**Templates** (self-contained — build first): `POST/GET /api/admin/email/templates`, `GET /:id`, optional `DELETE`. Store **block JSON** (`C.blocks`) so a loaded template rehydrates the editor, plus denormalized `body_html`. Composer gets a template picker + "Save as template".

**Scheduled sends:** refactor recipient resolution out of `/send` into `resolveRecipients({variant, list})`. Add `POST /api/admin/email/schedule` (+ `scheduledAt`, persists `target_variant`/`target_list`, status `'scheduled'`) and `POST /blasts/:id/cancel`. **Scheduler:** in-process `setInterval(~30s)` in `index.js` after `ensureSchema`; each tick claims due blasts atomically (`UPDATE ... SET status='sending' WHERE id=$1 AND status='scheduled' RETURNING id`), resolves recipients **at fire time**, calls `runBlast`. ⚠️ In-process assumes the Render web service is on an **always-on paid plan**; otherwise use a Render Cron Job. Composer: `datetime-local` (labeled `tzAbbr()`) + Schedule button, plus an Upcoming table with Cancel.

**Click tracking** (needs Phase 2 `provider_message_id` + Phase 3 webhook): `Click` event → `UPDATE email_sends SET clicks = clicks + 1, first_click_at = COALESCE(first_click_at, now()) WHERE provider_message_id = $1`. Add Clicked/CTR columns to blast + per-send history.

## Open items

1. **Render plan** — always-on paid? Determines in-process scheduler vs Render Cron (Phase 4).
2. **Start point** — Phase 0 + 2 alone remove the limit and fix deliverability; recommend shipping 0→2 first, verifying a real drop, then 3→4.
3. **Postmark approval** — bulk on the Broadcast stream may get a quick compliance review; a legit opt-in list with unsubscribe should pass.
