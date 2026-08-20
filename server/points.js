// Loyalty points ("Wilhelm points"). The ledger (point_events) is the source of
// truth; balances are always derived from it. Two numbers matter:
//   • lifetimeEarned — SUM of positive deltas. Never goes down. Drives permanent
//     STATUS unlocks (e.g. the Pre-Order privilege: cross the mark once, keep it).
//   • balance        — SUM of all deltas (earned − spent). This is the spendable
//     wallet for redemptions that deduct (e.g. a free bottle).
// Awards are idempotent via the ledger's UNIQUE (email, reason, ref_type, ref_id):
// awarding the same order/review twice is a no-op.
import { q } from './db.js';

const norm = (e) => String(e || '').trim().toLowerCase();

// ── Config (adjust in one place) ──────────────────────────────────────────────
// Values are placeholders pending final numbers.
export const POINTS = {
  perBottle: 25,        // per bottle, on a paid order
  review: 50,           // reviewing a batch you bought
  recipeRating: 10,     // rating a recipe (not wired yet)
  recipeAdd: 100,       // a recipe of yours gets published (not wired yet)
};
// Status thresholds (lifetime earned). Permanent once reached.
export const PREORDER_THRESHOLD = 200;

// Record one ledger event. Idempotent: a duplicate (email,reason,ref) is ignored.
// Returns true if a row was actually written.
export async function award(email, delta, reason, refType = '', refId = '', at = null) {
  const e = norm(email);
  if (!e || !delta) return false;
  const r = await q(
    `INSERT INTO point_events (email, delta, reason, ref_type, ref_id, created_at)
     VALUES ($1,$2,$3,$4,$5, COALESCE($6, now()))
     ON CONFLICT (email, reason, ref_type, ref_id) DO NOTHING
     RETURNING id`,
    [e, delta, reason, String(refType), String(refId), at]);
  return !!r.rows.length;
}

// { balance, lifetimeEarned, spent } for one member.
export async function pointsSummary(email) {
  const r = await q(
    `SELECT COALESCE(SUM(delta),0)::int AS balance,
            COALESCE(SUM(delta) FILTER (WHERE delta > 0),0)::int AS earned,
            COALESCE(-SUM(delta) FILTER (WHERE delta < 0),0)::int AS spent
       FROM point_events WHERE email = $1`, [norm(email)]);
  const row = r.rows[0] || { balance: 0, earned: 0, spent: 0 };
  return { balance: row.balance, lifetimeEarned: row.earned, spent: row.spent };
}

// Award points for one paid order (perBottle × quantity). Safe to call repeatedly.
export async function awardPurchase(orderId) {
  const r = await q(
    `SELECT id, email, quantity FROM orders
      WHERE id = $1 AND status = 'paid' AND email IS NOT NULL`, [orderId]);
  const o = r.rows[0];
  if (!o) return false;
  return award(o.email, (o.quantity || 1) * POINTS.perBottle, 'purchase', 'order', String(o.id), null);
}

// One-time (idempotent) backfill: award purchase points for every existing paid
// order that doesn't already have a ledger row. Demo orders (status='demo') are
// naturally excluded. Runs at boot; the UNIQUE key makes re-runs free.
export async function backfillPurchasePoints() {
  const r = await q(
    `INSERT INTO point_events (email, delta, reason, ref_type, ref_id, created_at)
       SELECT lower(email), GREATEST(quantity,1) * $1, 'purchase', 'order', id::text,
              COALESCE(paid_at, created_at)
         FROM orders
        WHERE status = 'paid' AND email IS NOT NULL
     ON CONFLICT (email, reason, ref_type, ref_id) DO NOTHING`,
    [POINTS.perBottle]);
  if (r.rowCount) console.log(`[points] backfilled purchase points for ${r.rowCount} order(s)`);
  return r.rowCount;
}
