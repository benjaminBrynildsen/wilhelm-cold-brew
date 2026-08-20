// Stripe-powered Friday Drop storefront: drop inventory + Checkout + on-page
// PaymentIntent (Apple/Google Pay + card) + webhook.
// No card data ever touches our server (Stripe.js / hosted Checkout).
import Stripe from 'stripe';
import { q } from './db.js';
import { sendOrderConfirmation, sendOrderAlert } from './mailer.js';
import { awardPurchase } from './points.js';

const SITE = process.env.SITE_URL || 'https://wilhelmcoldbrew.com';
const SHIP_CENTS = parseInt(process.env.SHIP_CENTS || '800', 10); // flat US shipping (per order)
const MAX_PER_ORDER = Math.max(1, parseInt(process.env.MAX_PER_ORDER || '6', 10)); // bottles per order cap
// Stripe Tax must be enabled + an origin address set in the Stripe dashboard before
// turning this on, otherwise Checkout creation errors. Flip STRIPE_TAX=1 once configured.
// NOTE: only the hosted /api/checkout path supports automatic_tax; the on-page
// PaymentIntent path charges a flat price (no itemized tax) by design.
const TAX_ENABLED = process.env.STRIPE_TAX === '1';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (stripe) console.log('[checkout] Stripe configured', TAX_ENABLED ? '(tax on)' : '(tax off)');
else console.warn('[checkout] STRIPE_SECRET_KEY missing — checkout disabled.');

export function stripeReady() { return !!stripe; }

// Pull the shipping block (name/phone/address) for a payment intent straight from
// Stripe. Used to backfill any paid order whose shipping wasn't captured by the
// webhook, so the Pirate Ship export is never missing an address.
export async function getShippingFromStripe(paymentIntentId) {
  if (!stripe || !paymentIntentId) return null;
  try {
    const full = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    let ship = full.shipping || null;
    const charge = full.latest_charge && typeof full.latest_charge === 'object' ? full.latest_charge : null;
    if (!ship && charge?.shipping) ship = charge.shipping;
    const email = full.receipt_email || charge?.billing_details?.email || full.customer_details?.email || null;
    if (!ship) return { email };
    return { name: ship.name || null, phone: ship.phone || null, address: ship.address || null, email };
  } catch (e) { console.warn('[pirateship] stripe shipping fetch failed:', e?.message || e); return null; }
}

// The currently-buyable drop (status='live') with its sold count + remaining.
// "sold" counts BOTTLES (sum of quantity), not orders.
async function currentDrop() {
  const r = await q(
    `SELECT d.*,
       (SELECT COALESCE(SUM(o.quantity),0)::int FROM orders o WHERE o.drop_id = d.id AND o.status = 'paid') AS sold
       FROM drops d WHERE d.status = 'live'
      ORDER BY d.opens_at DESC NULLS LAST, d.id DESC LIMIT 1`);
  if (!r.rows.length) return null;
  const d = r.rows[0];
  d.remaining = Math.max(0, d.bottle_cap - d.sold);
  return d;
}

// Bottles taken against a drop's cap: paid + recent-pending (soft reservation).
// Sums quantity so a multi-bottle pending order reserves all its bottles.
// The hold clock starts when the buyer taps Pay (intent creation), so a few
// minutes covers any real payment; an abandoned last bottle goes back on sale
// fast instead of sitting reserved for half an hour.
const HOLD_MINUTES = Math.max(1, parseInt(process.env.HOLD_MINUTES || '3', 10));
async function reservedBottles(dropId) {
  const r = await q(
    `SELECT COALESCE(SUM(quantity),0)::int n FROM orders
      WHERE drop_id = $1 AND (status = 'paid'
         OR (status = 'pending' AND created_at > now() - ($2 || ' minutes')::interval))`,
    [dropId, String(HOLD_MINUTES)]);
  return r.rows[0].n;
}

// Soonest upcoming scheduled drop (for the sold-out page "next drop" line).
async function nextScheduledAt() {
  const r = await q(
    `SELECT opens_at FROM drops
      WHERE status = 'scheduled' AND (opens_at IS NULL OR opens_at > now())
      ORDER BY opens_at ASC NULLS LAST LIMIT 1`);
  return r.rows[0]?.opens_at || null;
}

export function mountCheckout(app, payLimit = (req, res, next) => next()) {
  // Publishable key for Stripe.js on the buy page (safe to expose).
  app.get('/api/config', (_req, res) => {
    res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null });
  });

  // What the /buy and /sold-out pages read to decide buy vs sold-out.
  app.get('/api/drop/current', async (_req, res) => {
    try {
      const d = await currentDrop();
      const nextDropAt = await nextScheduledAt();
      if (d && d.remaining > 0) {
        return res.json({
          available: true, dropId: d.id, name: d.name,
          priceCents: d.price_cents, remaining: d.remaining,
          maxPerOrder: Math.min(MAX_PER_ORDER, d.remaining),
          tastingNotes: d.tasting_notes || null,
          origin: d.origin || null, varietal: d.varietal || null,
          elevation: d.elevation || null, roast: d.roast || null,
          shipCents: SHIP_CENTS, nextDropAt,
        });
      }
      // Not buyable: the drop the visitor just missed is the most recent drop
      // that has actually OPENED — not the newest row, which is next week's
      // scheduled batch as soon as it's created, and that bug left sold-out
      // "would've bought" votes untagged (dropId null → invisible in the
      // admin's per-drop demand count).
      const missedDrop = (d && d.remaining <= 0)
        ? d
        : (await q(
            `SELECT * FROM drops WHERE status <> 'scheduled'
              ORDER BY opens_at DESC NULLS LAST, created_at DESC LIMIT 1`)).rows[0] || null;
      const soldOut = (d && d.remaining <= 0) || missedDrop?.status === 'soldout';
      const dropId = missedDrop?.id ?? null;

      // Identity + tasting card for the batch they missed, so repeat visitors see
      // a real, specific batch (name, how fast it went, its notes) rather than the
      // same static page every week. Deliberately NO bottle counts are exposed.
      let missed = null;
      if (missedDrop) {
        missed = {
          name: missedDrop.name || ('Batch № ' + missedDrop.id),
          tastingNotes: missedDrop.tasting_notes || null,
          origin: missedDrop.origin || null, varietal: missedDrop.varietal || null,
          elevation: missedDrop.elevation || null, roast: missedDrop.roast || null,
          soldOutSeconds: null,
        };
        // How fast it sold out: from the drop's open time to the paid order that
        // reached the cap. Best-effort — a timing hiccup must never break the page.
        try {
          const t = (await q(
            `WITH cum AS (
               SELECT o.paid_at, SUM(o.quantity) OVER (ORDER BY o.paid_at, o.id) AS running
                 FROM orders o
                WHERE o.drop_id = $1 AND o.status = 'paid' AND o.paid_at IS NOT NULL)
             SELECT (SELECT MIN(paid_at) FROM cum WHERE running >= $2) AS soldout_at,
                    (SELECT MIN(paid_at) FROM cum) AS first_paid`,
            [missedDrop.id, missedDrop.bottle_cap])).rows[0];
          if (t && t.soldout_at && t.first_paid) {
            // Anchor to the FIRST paid order, NOT the drop's scheduled opens_at:
            // going live doesn't stamp a real open time, so opens_at can be days
            // stale (it once read "14 days" for a batch that sold out in hours).
            // First sale → cap-reaching sale is the true "how long the bottles lasted".
            const secs = Math.round((new Date(t.soldout_at) - new Date(t.first_paid)) / 1000);
            if (secs > 0) missed.soldOutSeconds = secs;
          }
        } catch (e) { console.warn('[drop/current] sold-out timing:', e?.message || e); }
      }
      res.json({ available: false, soldOut, dropId, nextDropAt, shipCents: SHIP_CENTS, missed });
    } catch (e) { console.error('[drop/current]', e); res.status(500).json({ error: e.message }); }
  });

  // On-page payment: reserve against the cap, create a PaymentIntent the buy page
  // confirms with Apple/Google Pay (Express Checkout Element) or card (Payment Element).
  app.post('/api/pay/intent', payLimit, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'payments not configured' });
    try {
      const d = await currentDrop();
      if (!d) return res.status(409).json({ error: 'no_live_drop' });

      const taken = await reservedBottles(d.id);
      const available = Math.min(MAX_PER_ORDER, d.bottle_cap - taken);
      if (available <= 0) return res.status(409).json({ error: 'sold_out' });

      let qty = parseInt(req.body?.quantity, 10) || 1;
      qty = Math.max(1, Math.min(available, qty));

      const variant = req.body?.variant ? String(req.body.variant).slice(0, 40) : null;
      const twclid = req.body?.twclid ? String(req.body.twclid).slice(0, 120) : null;

      const order = await q(
        `INSERT INTO orders (drop_id, quantity, variant, twclid, status)
         VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
        [d.id, qty, variant, twclid]);
      const orderId = order.rows[0].id;

      const amount = qty * d.price_cents + SHIP_CENTS;
      const pi = await stripe.paymentIntents.create({
        amount,
        currency: 'usd',
        // Account already has only card/Apple/Google/Link/Amazon enabled
        // (Cash App + US bank are off), so automatic shows exactly those.
        automatic_payment_methods: { enabled: true },
        description: `Wilhelm Cold Brew — ${qty} × 750ml`,
        metadata: {
          order_id: String(orderId), drop_id: String(d.id),
          qty: String(qty), variant: variant || '', twclid: twclid || '',
        },
      }, { idempotencyKey: `pi_order_${orderId}` });

      await q(`UPDATE orders SET stripe_payment_intent = $1 WHERE id = $2`, [pi.id, orderId]);
      res.json({
        clientSecret: pi.client_secret, paymentIntentId: pi.id,
        amount, qty, priceCents: d.price_cents, shipCents: SHIP_CENTS,
      });
    } catch (e) {
      console.error('[pay/intent]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // Emergency fallback: hosted Stripe Checkout (Apple/Google Pay on Stripe's page).
  app.post('/api/checkout', payLimit, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'payments not configured' });
    try {
      const d = await currentDrop();
      if (!d) return res.status(409).json({ error: 'no_live_drop' });

      const taken = await reservedBottles(d.id);
      const available = Math.min(MAX_PER_ORDER, d.bottle_cap - taken);
      if (available <= 0) return res.status(409).json({ error: 'sold_out' });
      let qty = parseInt(req.body?.quantity, 10) || 1;
      qty = Math.max(1, Math.min(available, qty));

      const variant = req.body?.variant ? String(req.body.variant).slice(0, 40) : null;
      const twclid = req.body?.twclid ? String(req.body.twclid).slice(0, 120) : null;

      const order = await q(
        `INSERT INTO orders (drop_id, quantity, variant, twclid, status)
         VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
        [d.id, qty, variant, twclid]);
      const orderId = order.rows[0].id;

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          quantity: qty,
          price_data: {
            currency: 'usd',
            unit_amount: d.price_cents,
            tax_behavior: 'exclusive',
            product_data: {
              name: 'Wilhelm Cold Brew — 750ml',
              description: d.name || 'Bourbon-barrel-aged cold brew. Small batch, non-alcoholic.',
            },
          },
        }],
        shipping_address_collection: { allowed_countries: ['US'] },
        shipping_options: [{
          shipping_rate_data: {
            type: 'fixed_amount',
            display_name: 'Shipping',
            tax_behavior: 'exclusive',
            fixed_amount: { amount: SHIP_CENTS, currency: 'usd' },
          },
        }],
        automatic_tax: { enabled: TAX_ENABLED },
        phone_number_collection: { enabled: true },
        metadata: { order_id: String(orderId), drop_id: String(d.id), qty: String(qty), variant: variant || '', twclid: twclid || '' },
        success_url: `${SITE}/thank-you?s={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE}/buy`,
      });

      await q(`UPDATE orders SET stripe_session_id = $1 WHERE id = $2`, [session.id, orderId]);
      res.json({ url: session.url });
    } catch (e) {
      console.error('[checkout]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // Thank-you page reads one of these to show the order summary.
  app.get('/api/order/:session', (req, res) => orderLookup(res, 'stripe_session_id', req.params.session));
  app.get('/api/order/by-intent/:pi', (req, res) => orderLookup(res, 'stripe_payment_intent', req.params.pi));
}

async function orderLookup(res, column, value) {
  try {
    const v = String(value || '').slice(0, 200);
    const r = await q(
      `SELECT o.id, o.email, o.amount_total_cents, o.status, o.shipping_name, o.quantity, d.name AS drop_name
         FROM orders o LEFT JOIN drops d ON d.id = o.drop_id
        WHERE o.${column} = $1 LIMIT 1`, [v]);
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch (e) { console.error('[order]', e); res.status(500).json({ error: e.message }); }
}

// Stripe webhook — MUST be mounted with express.raw() before express.json() so the
// signature can be verified against the exact bytes Stripe sent.
export async function stripeWebhook(req, res) {
  if (!stripe) return res.status(503).end();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  // Fail CLOSED in production: without the signing secret we cannot tell a real
  // Stripe event from a forged one, so refuse rather than trust an unsigned body
  // (which would let anyone mark orders paid). The unsigned parse stays only as a
  // local-dev convenience when NODE_ENV isn't production.
  if (!secret && process.env.NODE_ENV === 'production') {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET not set in production — rejecting unverifiable webhook.');
    return res.status(503).send('Webhook not configured');
  }
  let event;
  try {
    if (secret) {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
    } else {
      event = JSON.parse(req.body.toString('utf8')); // dev-only fallback (never reached in production)
    }
  } catch (e) {
    console.warn('[webhook] signature verification failed:', e?.message || e);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') {
        await markPaidBySession(s);
      }
    } else if (event.type === 'payment_intent.succeeded') {
      await markPaidByIntent(event.data.object);
    } else if (event.type === 'payment_intent.payment_failed') {
      await q(`UPDATE orders SET status = 'failed' WHERE stripe_payment_intent = $1 AND status = 'pending'`,
        [event.data.object.id]).catch(() => {});
    } else if (event.type === 'checkout.session.expired') {
      await q(`UPDATE orders SET status = 'failed' WHERE stripe_session_id = $1 AND status = 'pending'`,
        [event.data.object.id]).catch(() => {});
    } else if (event.type === 'charge.refunded') {
      const pi = event.data.object.payment_intent;
      if (pi) await q(`UPDATE orders SET status = 'refunded' WHERE stripe_payment_intent = $1`, [pi]).catch(() => {});
    }
  } catch (e) {
    console.error('[webhook] handler error:', e);
    // 200 anyway: Stripe retries on non-2xx, but a handler bug shouldn't loop forever.
  }
  res.json({ received: true });
}

// Hosted-Checkout path: pending order → paid, keyed on the session id.
async function markPaidBySession(s) {
  const ship = s.shipping_details || s.collected_information?.shipping_details || null;
  const email = s.customer_details?.email || s.customer_email || null;
  const shippingName = ship?.name || s.customer_details?.name || null;
  const upd = await q(
    `UPDATE orders SET status = 'paid', email = $2, amount_total_cents = $3,
            stripe_payment_intent = $4, shipping_name = $5, shipping_address = $6, paid_at = now()
      WHERE stripe_session_id = $1 AND status <> 'paid'
      RETURNING id, drop_id`,
    [s.id, email, s.amount_total ?? null, s.payment_intent ?? null,
     shippingName, ship?.address ? JSON.stringify(ship.address) : null]);
  if (!upd.rows.length) return; // already processed — skip duplicate emails
  await finalizePaidOrder({
    orderId: upd.rows[0].id, dropId: upd.rows[0].drop_id,
    email, amountCents: s.amount_total ?? null, shippingName,
  });
}

// On-page PaymentIntent path: pending order → paid, keyed on the payment intent id.
async function markPaidByIntent(pi) {
  let email = pi.receipt_email || pi.customer_details?.email || null;
  let ship = pi.shipping || null;
  // The Express/Payment element doesn't always put email/shipping on the bare
  // event object — backfill from the charge if needed.
  if (!email || !ship) {
    try {
      const full = await stripe.paymentIntents.retrieve(pi.id, { expand: ['latest_charge'] });
      ship = ship || full.shipping || null;
      const charge = full.latest_charge && typeof full.latest_charge === 'object' ? full.latest_charge : null;
      email = email || charge?.billing_details?.email || full.receipt_email || null;
      if (!ship && charge?.shipping) ship = charge.shipping;
    } catch (e) { console.warn('[webhook] PI retrieve failed:', e?.message || e); }
  }
  const amountCents = pi.amount_received ?? pi.amount ?? null;
  const upd = await q(
    `UPDATE orders SET status = 'paid', email = $2, amount_total_cents = $3,
            shipping_name = $4, shipping_address = $5, paid_at = now()
      WHERE stripe_payment_intent = $1 AND status <> 'paid'
      RETURNING id, drop_id`,
    [pi.id, email, amountCents, ship?.name || null, ship?.address ? JSON.stringify(ship.address) : null]);
  if (!upd.rows.length) return; // already processed — skip duplicate emails
  await finalizePaidOrder({
    orderId: upd.rows[0].id, dropId: upd.rows[0].drop_id,
    email, amountCents, shippingName: ship?.name || null,
  });
}

// Shared tail for both paid paths: close the drop at cap (by BOTTLES) + send emails.
async function finalizePaidOrder({ orderId, dropId, email, amountCents, shippingName }) {
  // Loyalty points, credited the moment the order is paid. Idempotent.
  if (orderId) awardPurchase(orderId).catch((e) => console.warn('[points] purchase award failed:', e?.message || e));
  let dropName = null;
  if (dropId) {
    const d = (await q(
      `SELECT name, bottle_cap,
         (SELECT COALESCE(SUM(o.quantity),0)::int FROM orders o WHERE o.drop_id = drops.id AND o.status = 'paid') AS sold
         FROM drops WHERE id = $1`, [dropId])).rows[0];
    dropName = d?.name || null;
    if (d && d.sold >= d.bottle_cap) {
      await q(`UPDATE drops SET status = 'soldout' WHERE id = $1 AND status = 'live'`, [dropId]).catch(() => {});
    }
  }
  if (email) {
    sendOrderConfirmation(email, { dropName, amountCents, shippingName })
      .catch((e) => console.warn('[webhook] confirmation email failed:', e?.message || e));
  }
  sendOrderAlert({ email, amountCents, dropName, shippingName })
    .catch((e) => console.warn('[webhook] order alert failed:', e?.message || e));
}
