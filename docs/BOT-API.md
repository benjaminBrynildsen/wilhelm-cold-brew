# Bot API — scoped admin access for an assistant (e.g. grokbot)

A limited token that lets an outside bot **read** the admin data and perform a
small set of **non-destructive writes**. It is separate from your own admin
login and from the full `ADMIN_API_KEY`, so you can revoke/rotate it on its own.

## Setup

1. On Render → the service → Environment, add a secret:
   ```
   BOT_API_KEY = <a long random string>
   ```
   Until this is set, the bot path is completely off.
2. The bot sends that value in the `x-bot-key` header on **every** request:
   ```
   x-bot-key: <the BOT_API_KEY value>
   ```
3. Base URL: `https://wilhelmcoldbrew.com`

Discover what the token can do at runtime:
```
GET /api/admin/bot/manifest
```

## What it can do

- **Read:** any `GET /api/admin/*` endpoint — orders, analytics/overview,
  subscribers, drops, the Ledger, shipping, etc.
- **Write (allowlist only):**
  - `POST /api/admin/drops` — schedule a new drop (always created as
    `scheduled`; you still hit "Go live" yourself)
  - `POST /api/admin/drops/:id/rename`
  - `POST /api/admin/drops/:id/opens` — reschedule
  - `POST /api/admin/drops/:id/price`
  - `POST /api/admin/drops/:id/cap`
  - `POST /api/admin/drops/:id/products` — edit the per-bottle lineup
  - `POST /api/admin/drops/:id/notes` — tasting notes
  - `POST /api/admin/journal` — create / edit a Ledger **draft**

## What it can NEVER do

Go live or close a drop · publish a Ledger article · send SMS or email ·
delete anything · edit a drop while it is **live** · edit a **published**
article · archive or modify subscribers. Anything not on the allowlist returns
`403`. Bot requests are rate-limited to 120/minute.

## Examples

```bash
# Read the orders for the current drop
curl -H "x-bot-key: $BOT_API_KEY" https://wilhelmcoldbrew.com/api/admin/orders

# Schedule next week's batch (stays 'scheduled' until you go live)
curl -H "x-bot-key: $BOT_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Batch 80","priceCents":5000,"bottleCap":65,"opensAt":"2026-10-16T14:00:00Z"}' \
  https://wilhelmcoldbrew.com/api/admin/drops
```

`opensAt` is an ISO timestamp (UTC). Prices are in cents (`5000` = $50.00).
