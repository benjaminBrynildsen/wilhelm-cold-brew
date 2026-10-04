# Bot API Guide — scoped admin access for an assistant (e.g. grokbot)

A limited token that lets an outside bot **read** the admin data and perform a
small set of **non-destructive writes**. It is separate from your own admin
login and from the full `ADMIN_API_KEY`, so you can revoke/rotate it on its own.

> **Live spec:** `GET /api/admin/bot/manifest` returns this same endpoint list,
> params, and write bodies as JSON — point the bot at it so it always has the
> current contract.

---

## Setup

1. Render → the service → **Environment** → add a secret:
   ```
   BOT_API_KEY = <a long random string>
   ```
   Until this is set, the bot path is completely off.
2. The bot sends that value in the `x-bot-key` header on **every** request.
3. Base URL: `https://wilhelmcoldbrew.com`

## Conventions

- **Money** is integer **cents**: `5000` = $50.00.
- **Timestamps** are **ISO-8601 UTC**: `2026-10-16T14:00:00Z`.
  9:00 AM Central = `14:00Z` (summer/CDT) or `15:00Z` (winter/CST).
- **Analytics windows:** `?win=today | d7 | d30 | all`, or
  `?win=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`.
- Auth failure → `401`. Disallowed action → `403`. Rate limit → `429`
  (120 requests/minute).

---

## Reads — any `GET /api/admin/*`

The ones a bot will actually use:

| Endpoint | Returns |
|---|---|
| `GET /api/admin/overview` | Since-launch daily rollup: sessions, drink-page visits, signups per day + running totals |
| `GET /api/admin/signups-today` | Today's signups, SMS opt-ins, drink→signup conversion %, welcome replies (Central day) |
| `GET /api/admin/funnel?win=` | Funnel conversion for the window, with by-variant breakdown |
| `GET /api/admin/traffic?win=` | Page views + unique visitors |
| `GET /api/admin/orders?dropId=` | Paid count, revenue, order list with per-bottle line items (omit `dropId` = all-time) |
| `GET /api/admin/drops` | Every drop: name, status, `opens_at`, sold/cap, price, products |
| `GET /api/admin/subscribers?limit=` | Subscriber list — **contains PII** (emails, phones, UTM source) |
| `GET /api/admin/shipping?dropId=` | Per-batch shipped/delivered rollup + per-shipment list |
| `GET /api/admin/botcatcher?win=` | Signups flagged as likely bots |
| `GET /api/admin/journeys` · `/journeys/:sessionId` | Visitor session list / single replay |
| `GET /api/admin/reviews` | Welcome-email replies |
| `GET /api/admin/email/history` · `/email/blasts` | Email send + open stats |
| `GET /api/admin/journal` · `/journal/:id` · `/journal/drops` | Ledger articles (list / one / linkable drops) |
| `GET /api/admin/orders/packing.html?dropId=` | Printable per-bottle packing list (HTML) |
| `GET /api/admin/orders/pirateship.csv` · `usps.csv` `?dropId=&scope=&split=` | Shipping label exports (CSV) |

Other `GET /api/admin/*` endpoints are readable too; the above are the useful data ones.

---

## Writes — allowlist only

| Method & path | Body | Notes |
|---|---|---|
| `POST /api/admin/drops` | `{name, priceCents, bottleCap, opensAt?, tastingNotes?}` | Creates as **scheduled**; you go live manually |
| `POST /api/admin/drops/:id/rename` | `{name}` | |
| `POST /api/admin/drops/:id/opens` | `{opensAt}` (empty clears) | Reschedule · not while live |
| `POST /api/admin/drops/:id/price` | `{priceCents}` | not while live |
| `POST /api/admin/drops/:id/cap` | `{bottleCap}` | not while live |
| `POST /api/admin/drops/:id/products` | `{products:[{name, priceCents, bottleCap, tastingNotes?, origin?, varietal?, elevation?, roast?, image?}]}` | max 6; replaces all bottles; `[]` = single-bottle · not while live |
| `POST /api/admin/drops/:id/notes` | `{tastingNotes, origin?, varietal?, elevation?, roast?}` | not while live |
| `POST /api/admin/journal` | `{id?, title, category?, summary?, dek?, body, refs?, drop_id?}` | Creates/edits a **draft** (omit `id` to create). Cannot edit a published article |

## Never allowed (always `403`)

Go live or close a drop · publish a Ledger article · send SMS or email · delete
anything · edit a drop **while it's live** · edit a **published** article ·
archive or modify subscribers · anything not in the writes table above.

---

## Examples

```bash
BASE=https://wilhelmcoldbrew.com
H="x-bot-key: $BOT_API_KEY"

# Today's numbers
curl -H "$H" "$BASE/api/admin/signups-today"

# This week's funnel
curl -H "$H" "$BASE/api/admin/funnel?win=d7"

# Orders for a specific drop
curl -H "$H" "$BASE/api/admin/orders?dropId=42"

# Schedule next week's batch (stays 'scheduled' until you go live)
curl -H "$H" -H "Content-Type: application/json" \
  -d '{"name":"Batch 80","priceCents":5000,"bottleCap":65,"opensAt":"2026-10-16T14:00:00Z"}' \
  "$BASE/api/admin/drops"

# Draft a Ledger article
curl -H "$H" -H "Content-Type: application/json" \
  -d '{"title":"How we pick a barrel","body":"## Draft\n\nText here."}' \
  "$BASE/api/admin/journal"
```
