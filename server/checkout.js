// Stripe-powered Friday Drop storefront: drop inventory + Checkout + webhook.
// Raw SQL via q(); no card data ever touches our server (hosted Checkout).
import Stripe from 'stripe';
import { q } from './db.js';
import { sendOrderConfirmation, sendOrderAlert } from './mailer.js';

const SITE = process.env.SITE_URL || 'https://wilhelmcoldbrew.com';
const SHIP_CENTS = parseInt(process.env.SHIP_CENTS || '800', 10); // flat US shipping
// Stripe Tax must be enabled + an origin address set in the Stripe dashboard before
// turning this on, otherwise Checkout creation errors. Flip STRIPE_TAX=1 once configured.
const TAX_ENABLED = process.env.STRIPE_TAX === '1';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (stripe) console.log('[checkout] Stripe configured', TAX_ENABLED ? '(tax on)' : '(tax off)');
else console.warn('[checkout] STRIPE_SECRET_KEY missing — checkout disabled.');

export function stripeReady() { return !!stripe; }

// The currently-buyable drop (status='live') with its sold count + remaining.
async function currentDrop() {
  const r = await q(
    `SELECT d.*,
       (SELECT COUNT(*)::int FROM orders o WHERE o.drop_id = d.id AND o.status = 'paid') AS sold
       FROM drops d WHERE d.status = 'live'
      ORDER BY d.opens_at DESC NULLS LAST, d.id DESC LIMIT 1`);
  if (!r.rows.length) return null;
  const d = r.rows[0];
  d.remaining = Math.max(0, d.bottle_cap - d.sold);
  return d;
}

// Soonest upcoming scheduled drop (for the sold-out page "next drop" line).
async function nextScheduledAt() {
  const r = await q(
    `SELECT opens_at FROM drops
      WHERE status = 'scheduled' AND (opens_at IS NULL OR opens_at > now())
      ORDER BY opens_at ASC NULLS LAST LIMIT 1`);
  return r.rows[0]?.opens_at || null;
}

export function mountCheckout(app) {
  // What the /buy and /sold-out pages read to decide buy vs sold-out.
  app.get('/api/drop/current', async (_req, res) => {
    try {
      const d = await currentDrop();
      const nextDropAt = await nextScheduledAt();
      if (d && d.remaining > 0) {
        return res.json({
          available: true, dropId: d.id, name: d.name,
          priceCents: d.price_cents, remaining: d.remaining,
          shipCents: SHIP_CENTS, nextDropAt,
        });
      }
      // Not buyable: distinguish "this week sold out" from "nothing scheduled" by the
      // latest drop's status (a live-at-cap drop, or a soldout one with nothing newer).
      const latest = (await q(`SELECT status FROM drops ORDER BY created_at DESC LIMIT 1`)).rows[0];
      const soldOut = (d && d.remaining <= 0) || latest?.status === 'soldout';
      res.json({ available: false, soldOut, nextDropAt, shipCents: SHIP_CENTS });
    } catch (e) { console.error('[drop/current]', e); res.status(500).json({ error: e.message }); }
  });

  // Start a purchase: reserve against the cap, create a Stripe Checkout Session.
  app.post('/api/checkout', async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'payments not configured' });
    try {
      const d = await currentDrop();
      if (!d) return res.status(409).json({ error: 'no_live_drop' });

      // Soft reservation: paid + recent-pending count toward the cap so we don't
      // oversell during the rush. (Not a hard lock — see plan's oversell note.)
      const taken = (await q(
        `SELECT COUNT(*)::int n FROM orders
          WHERE drop_id = $1 AND (status = 'paid'
             OR (status = 'pending' AND created_at > now() - interval '30 minutes'))`,
        [d.id])).rows[0].n;
      if (taken >= d.bottle_cap) return res.status(409).json({ error: 'sold_out' });

      const variant = req.body?.variant ? String(req.body.variant).slice(0, 40) : null;
      const twclid = req.body?.twclid ? String(req.body.twclid).slice(0, 120) : null;

      const order = await q(
        `INSERT INTO orders (drop_id, variant, twclid, status) VALUES ($1,$2,$3,'pending') RETURNING id`,
        [d.id, variant, twclid]);
      const orderId = order.rows[0].id;

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          quantity: 1,
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
        metadata: { order_id: String(orderId), drop_id: String(d.id), variant: variant || '', twclid: twclid || '' },
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

  // Thank-you page reads this to show the order summary.
  app.get('/api/order/:session', async (req, res) => {
    try {
      const sid = String(req.params.session || '').slice(0, 200);
      const r = await q(
        `SELECT o.email, o.amount_total_cents, o.status, o.shipping_name, o.quantity, d.name AS drop_name
           FROM orders o LEFT JOIN drops d ON d.id = o.drop_id
          WHERE o.stripe_session_id = $1 LIMIT 1`, [sid]);
      if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
      res.json(r.rows[0]);
    } catch (e) { console.error('[order]', e); res.status(500).json({ error: e.message }); }
  });
}

// Stripe webhook — MUST be mounted with express.raw() before express.json() so the
// signature can be verified against the exact bytes Stripe sent.
export async function stripeWebhook(req, res) {
  if (!stripe) return res.status(503).end();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (secret) {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
    } else {
      event = JSON.parse(req.body.toString('utf8')); // dev fallback when no secret set
    }
  } catch (e) {
    console.warn('[webhook] signature verification failed:', e?.message || e);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') {
        await markPaid(s);
      }
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

// Transition a pending order → paid (idempotent: only the first transition sends emails).
async function markPaid(s) {
  const ship = s.shipping_details || s.collected_information?.shipping_details || null;
  const email = s.customer_details?.email || s.customer_email || null;
  const upd = await q(
    `UPDATE orders SET status = 'paid', email = $2, amount_total_cents = $3,
            stripe_payment_intent = $4, shipping_name = $5, shipping_address = $6, paid_at = now()
      WHERE stripe_session_id = $1 AND status <> 'paid'
      RETURNING id, drop_id`,
    [s.id, email, s.amount_total ?? null, s.payment_intent ?? null,
     ship?.name || s.customer_details?.name || null,
     ship?.address ? JSON.stringify(ship.address) : null]);
  if (!upd.rows.length) return; // already processed — skip duplicate emails

  const { drop_id } = upd.rows[0];
  // If this paid order hits the cap, close the drop.
  let dropName = null;
  if (drop_id) {
    const d = (await q(
      `SELECT name, bottle_cap,
         (SELECT COUNT(*)::int FROM orders o WHERE o.drop_id = drops.id AND o.status = 'paid') AS sold
         FROM drops WHERE id = $1`, [drop_id])).rows[0];
    dropName = d?.name || null;
    if (d && d.sold >= d.bottle_cap) {
      await q(`UPDATE drops SET status = 'soldout' WHERE id = $1 AND status = 'live'`, [drop_id]).catch(() => {});
    }
  }

  const amountCents = s.amount_total ?? null;
  const shippingName = ship?.name || s.customer_details?.name || null;
  if (email) {
    sendOrderConfirmation(email, { dropName, amountCents, shippingName })
      .catch((e) => console.warn('[webhook] confirmation email failed:', e?.message || e));
  }
  sendOrderAlert({ email, amountCents, dropName, shippingName })
    .catch((e) => console.warn('[webhook] order alert failed:', e?.message || e));
}
