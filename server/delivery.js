// Delivery-status provider layer. Prefers EasyPost (works for Pirate-Ship-tendered
// packages) and falls back to USPS-direct if only those keys are set. The Shipping
// tab talks to this, not to any one provider, so swapping providers changes nothing
// downstream. No-ops cleanly when neither is configured.
import { q } from './db.js';
import { uspsEnabled, uspsTrack, uspsProbe } from './usps.js';
import { easypostEnabled, epTrack, epProbe } from './easypost.js';

export function deliveryEnabled() { return easypostEnabled() || uspsEnabled(); }
export function deliveryProvider() { return easypostEnabled() ? 'easypost' : (uspsEnabled() ? 'usps' : null); }

async function trackOne(trackingNumber, carrier) {
  return easypostEnabled() ? epTrack(trackingNumber, carrier) : uspsTrack(trackingNumber);
}

export async function deliveryProbe(trackingNumber) {
  return easypostEnabled() ? epProbe(trackingNumber) : uspsProbe(trackingNumber);
}

// Poll the active provider for shipped-but-not-delivered packages that haven't
// been checked recently, and write results back. Bounded per call.
export async function refreshDeliveryStatuses({ limit = 40, force = false } = {}) {
  if (!deliveryEnabled()) return { enabled: false, checked: 0, delivered: 0, updated: 0 };
  const staleClause = force ? '' : `AND (tracking_checked_at IS NULL OR tracking_checked_at < now() - interval '2 hours')`;
  const rows = (await q(
    `SELECT id, tracking_number, tracking_carrier FROM orders
      WHERE status='paid' AND delivered_at IS NULL
        AND NULLIF(tracking_number,'') IS NOT NULL ${staleClause}
      ORDER BY tracking_checked_at ASC NULLS FIRST
      LIMIT $1`, [limit])).rows;
  let delivered = 0, updated = 0;
  for (const o of rows) {
    let res;
    try { res = await trackOne(o.tracking_number, o.tracking_carrier || 'USPS'); } catch (e) { res = { ok: false, error: e.message }; }
    if (!res.ok) {
      await q(`UPDATE orders SET tracking_checked_at = now() WHERE id=$1`, [o.id]).catch(() => {});
      continue;
    }
    await q(
      `UPDATE orders SET tracking_status=$1, delivered_at=$2, tracking_checked_at=now() WHERE id=$3`,
      [res.status || null, res.delivered ? (res.deliveredAt || new Date()) : null, o.id]).catch(() => {});
    updated += 1;
    if (res.delivered) delivered += 1;
  }
  return { enabled: true, provider: deliveryProvider(), checked: rows.length, delivered, updated };
}
