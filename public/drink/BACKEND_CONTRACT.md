# Friday Drop — email capture backend contract

The opt-in page (`/drink`) is fully built. The only missing piece is the backend
that receives signups. Build a service that satisfies the contract below and the
page works end-to-end — no frontend changes needed (the frontend already calls it
via `PROVIDER='endpoint'` in `optin.js`).

## Endpoint

```
POST /api/subscribe
Content-Type: application/json
```

### Request body
```json
{
  "email":   "you@email.com",   // string, already client-validated; RE-VALIDATE server-side
  "variant": "bullets"          // "minimal" | "image" | "bullets" — the split-test arm
}
```

### Response
| Result | Status | Frontend behavior |
|--------|--------|-------------------|
| Stored (or already on list) | **2xx** (200/201/202) | Renders the success state ("You're on the list.") |
| Anything else | non-2xx | Shows the inline gold error line; user can retry |

The frontend only checks `res.ok`. No response body is required. Return fast.

### Server-side requirements
- **Re-validate** the email: `^[^@\s]+@[^@\s]+\.[^@\s]+$` (don't trust the client).
- **Dedupe** by email (treat a repeat signup as success — return 2xx, don't error).
- **Store at least:** `email`, `variant`, `created_at`, and ideally `ip` / `user_agent`
  and `utm_*` if you start passing them. The `variant` column is what makes the
  split test measurable — count signups grouped by `variant`, and divide by
  exposures (the page fires a `drink_exposure` analytics event per arm).
- This list is what the scheduled **Friday 9AM** campaign sends to.

## Hosting / CORS

`CONFIG.endpoint.url` in `optin.js` defaults to **`/api/subscribe`** (same-origin).
Two ways to satisfy that:

1. **Same-origin (simplest for the browser):** serve the API under
   `wilhelmcoldbrew.com/api/*`. On Render that means converting the site from a
   *static site* to a *web service* that serves the static files **and** the API,
   or putting a proxy/rewrite in front. Then leave `url: '/api/subscribe'`.

2. **Separate API service (e.g. `api.wilhelmcoldbrew.com`):** set
   `CONFIG.endpoint.url` to the absolute URL and have the API send CORS headers:
   ```
   Access-Control-Allow-Origin: https://wilhelmcoldbrew.com
   Access-Control-Allow-Methods: POST, OPTIONS
   Access-Control-Allow-Headers: Content-Type
   ```
   (and handle the `OPTIONS` preflight).

## Analytics already emitted by the page

`optin.js` calls a generic `track()` that pushes to `dataLayer` (GA4/GTM),
`gtag`, and Meta Pixel `fbq` **if those scripts are present on the page**:
- `drink_exposure` `{ variant }` — on load, once per arm.
- `drink_signup` `{ variant }` — on successful submit. Also fires Meta `Lead`.

So you can measure the split test two ways: by `variant` counts in your own DB,
and/or via these events in GA/Meta. Add the GA/Pixel snippet to `index.html`
`<head>` if you want the event path.

## Quick local stub (for testing the full flow)

Any server returning 200 to `POST /api/subscribe` will light up the success state.
Example (Node/Express):
```js
app.post('/api/subscribe', express.json(), (req, res) => {
  const { email, variant } = req.body || {};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) return res.sendStatus(400);
  // TODO: dedupe + persist { email, variant, created_at }
  res.sendStatus(200);
});
```
