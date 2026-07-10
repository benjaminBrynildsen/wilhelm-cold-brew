// Transactional email via SMTP (nodemailer). Sends from ben@wilhelmcoldbrew.com.
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import { q } from './db.js';

const SITE = process.env.SITE_URL || 'https://wilhelmcoldbrew.com';

// A send is tracked by an open-tracking token. We mint the token up front (it's
// embedded in the email as the pixel + unsubscribe link), but only write the
// email_sends row AFTER the message actually goes out — so "Send history"
// reflects real deliveries, not attempts. (Previously the row was written before
// sending, so a failed sendMail left a phantom "sent" row that was never
// delivered — the Batch 58 failure mode.)
const mkToken = () => crypto.randomBytes(16).toString('hex');
async function recordSend(token, email, kind, blastId) {
  try {
    await q(`INSERT INTO email_sends (token, email, kind, blast_id) VALUES ($1,$2,$3,$4)`,
      [token, email, kind, blastId || null]);
  } catch (e) { console.warn('[mail] recordSend failed:', e?.message || e); }
}
const unsubUrl = (token) => `${SITE}/api/unsubscribe?t=${token}`;
const unsubHeaders = (token) => ({
  'List-Unsubscribe': `<${unsubUrl(token)}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
});

// Inject tracking pixel + replace the {{UNSUB_URL}} placeholder.
function finalize(html, token) {
  const px = `<img src="${SITE}/api/e/${token}" width="1" height="1" alt="" style="display:none;border:0"/>`;
  let out = html.replace(/\{\{UNSUB_URL\}\}/g, unsubUrl(token));
  return out.includes('</body>') ? out.replace('</body>', px + '</body>') : out + px;
}

// Footer appended to blast emails (compliance + unsubscribe).
function blastFooter(token) {
  return `<div style="max-width:520px;margin:28px auto 0;padding-top:18px;border-top:1px solid #e3dcc8;font-family:Arial,sans-serif;font-size:12px;color:#9a8f78;text-align:center;line-height:1.6;">
    Wilhelm Cold Brew · Small Batch · St. Louis, MO<br/>
    <a href="${unsubUrl(token)}" style="color:#9a8f78;text-decoration:underline;">Unsubscribe</a>
  </div>`;
}

const HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const FROM = process.env.MAIL_FROM || 'Wilhelm Cold Brew <ben@wilhelmcoldbrew.com>';
// Internal "new signup" alert recipient — pinged the moment someone joins.
// Who gets the internal new-signup alerts. SIGNUP_NOTIFY (env) sets the primary
// inbox (defaults to the sending account); Matt is always on the list too.
const SIGNUP_NOTIFY = [process.env.SIGNUP_NOTIFY || USER, 'mattbrynildsen@gmail.com']
  .filter(Boolean).join(', ');

let transporter = null;
if (USER && PASS) {
  transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: PORT === 465,
    auth: { user: USER, pass: PASS },
    // Pooling is critical for blasts: without it nodemailer opens a fresh SMTP
    // connection + full login per email, and ~80 rapid logins trips Gmail's
    // anti-abuse limiter (454-4.7.0 "too many login attempts" → ~1hr lockout).
    // One persistent connection, recycled every ~100 messages (Gmail's per-
    // connection ceiling), paced to a few messages/sec.
    pool: true,
    maxConnections: 1,
    maxMessages: 100,
    rateDelta: 1000,
    rateLimit: 3,
  });
  console.log('[mail] SMTP configured as', USER, '(pooled)');
} else {
  console.warn('[mail] SMTP not configured (SMTP_USER/SMTP_PASS missing) — emails will be skipped.');
}

export function mailReady() { return !!transporter; }

// ───────── Welcome email (sent on each new signup) ─────────
const WELCOME_SUBJECT = "One last step so you don't miss the drop";

function welcomeHtml() {
  return `<!doctype html>
<html><body style="margin:0;background:#e9dcbb;padding:0;">
  <div style="display:none;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">You're on the list for the Friday Drop. Here's how it works.&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9dcbb;">
    <tr><td align="center" style="padding:36px 18px;">
      <table role="presentation" width="100%" style="max-width:540px;background:#f7f0dd;border:1px solid #ddcfa6;border-radius:6px;">
        <tr><td style="padding:38px 42px 32px;">
          <div style="text-align:center;padding-bottom:26px;">
            <img src="${SITE}/drink/assets/wilhelm-circle.png" width="80" height="80" alt="Wilhelm Cold Brew" style="display:inline-block;border-radius:50%;border:0;"/>
            <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:3px;color:#b08a2c;margin-top:12px;">SMALL BATCH &middot; ST. LOUIS, MO</div>
          </div>
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.7;color:#241c10;">
            <p style="margin:0 0 18px;">You're on the list.</p>
            <p style="margin:0 0 18px;">One quick favor, sometimes the launch emails land in spam.</p>
            <p style="margin:0 0 18px;">We've had people tell us they missed a drop because of it.</p>
            <p style="margin:0 0 18px;">The email was sitting in their spam folder, and by the time they found it, the bottles were already gone.</p>
            <p style="margin:0 0 18px;">Don't let that be you.</p>
            <p style="margin:0 0 18px;"><strong style="color:#8a6914;">Hit reply and send a sentence or two.</strong></p>
            <p style="margin:0 0 18px;">That reply keeps the Friday launch email out of your spam folder.</p>
            <p style="margin:0 0 18px;">Google, Yahoo, and Microsoft treat a reply as proof you actually want us, so we land in your inbox instead of spam.</p>
            <p style="margin:0 0 18px;">And I read every one personally.</p>
            <p style="margin:0 0 18px;">Every <strong style="color:#8a6914;">Friday at 9AM</strong> the buy link lands in your inbox.</p>
            <p style="margin:0 0 18px;">Fewer than 100 bottles a batch, barrel-aged and single-origin.</p>
            <p style="margin:0 0 18px;">When you see the email, move quick.</p>
            <p style="margin:0 0 18px;">Blink and they're gone.</p>
            <p style="margin:0 0 22px;">Talk soon,<br/>Ben<br/><span style="color:#8a7d5f;">Wilhelm Cold Brew</span></p>
            <p style="margin:0 0 18px;">P.S. Reply with anything you like, but I'm always curious: what's your earliest memory of drinking coffee?</p>
            <p style="margin:0 0 18px;">For some it's a grandparent's kitchen, for others a late study session with friends at a local spot.</p>
            <p style="margin:0;">I'd love to hear yours.</p>
          </div>
          <div style="margin-top:30px;padding-top:18px;border-top:1px solid #e2d4ad;font-family:Arial,sans-serif;font-size:11px;color:#9a8d6e;line-height:1.6;">
            You're receiving this because you joined the Wilhelm Cold Brew Friday Drop list.<br/>
            <a href="{{UNSUB_URL}}" style="color:#b08a2c;text-decoration:underline;">Unsubscribe</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function welcomeText() {
  return [
    "You're on the list.",
    '',
    'One quick favor, sometimes the launch emails land in spam.',
    '',
    "We've had people tell us they missed a drop because of it.",
    '',
    'The email was sitting in their spam folder, and by the time they found it, the bottles were already gone.',
    '',
    "Don't let that be you.",
    '',
    'Hit reply and send a sentence or two.',
    '',
    'That reply keeps the Friday launch email out of your spam folder.',
    '',
    'Google, Yahoo, and Microsoft treat a reply as proof you actually want us, so we land in your inbox instead of spam.',
    '',
    'And I read every one personally.',
    '',
    'Every Friday at 9AM the buy link lands in your inbox.',
    '',
    'Fewer than 100 bottles a batch, barrel-aged and single-origin.',
    '',
    'When you see the email, move quick.',
    '',
    "Blink and they're gone.",
    '',
    'Talk soon,',
    'Ben',
    'Wilhelm Cold Brew',
    '',
    "P.S. Reply with anything you like, but I'm always curious: what's your earliest memory of drinking coffee?",
    '',
    "For some it's a grandparent's kitchen, for others a late study session with friends at a local spot.",
    '',
    "I'd love to hear yours.",
  ].join('\n');
}

// `record: false` proofs the email without writing an email_sends row — used by
// the admin welcome-test endpoint so test sends never inflate the open-rate stats.
export async function sendWelcome(to, { record = true } = {}) {
  if (!transporter) { console.warn('[mail] skip welcome (SMTP not configured):', to); return; }
  const token = mkToken();
  await transporter.sendMail({
    from: FROM,
    to,
    subject: WELCOME_SUBJECT,
    html: finalize(welcomeHtml(), token),
    text: welcomeText() + '\n\nUnsubscribe: ' + unsubUrl(token),
    headers: unsubHeaders(token),
  });
  if (record) await recordSend(token, to, 'welcome', null);
  console.log('[mail] welcome sent to', to, record ? '' : '(proof, not recorded)');
}

// ───────── Internal new-signup alert (to Ben, not the subscriber) ─────────
// Plain notification: no tracking pixel, no unsubscribe link, not logged to
// email_sends. Fire-and-forget so it never blocks or breaks the signup flow.
export async function sendSignupAlert(email, meta = {}) {
  if (!transporter || !SIGNUP_NOTIFY) return;
  const where = [meta.city, meta.region, meta.country].filter(Boolean).join(', ');
  const lines = [
    `New Friday Drop signup:`,
    ``,
    `  Email:   ${email}`,
    meta.variant ? `  Variant: ${meta.variant}` : null,
    where ? `  From:    ${where}` : null,
    ``,
    `See the dashboard: ${SITE}/admin`,
  ].filter((l) => l !== null);
  try {
    await transporter.sendMail({
      from: FROM,
      to: SIGNUP_NOTIFY,
      subject: `New signup: ${email}`,
      text: lines.join('\n'),
    });
    console.log('[mail] signup alert sent for', email);
  } catch (e) {
    console.warn('[mail] signup alert failed:', e?.message || e);
  }
}

// ───────── Order confirmation (to the buyer) + order alert (to Ben) ─────────
const ORDER_SUBJECT = 'Your Wilhelm order is confirmed';
const money = (c) => (c == null ? null : '$' + (c / 100).toFixed(2));

function orderHtml({ amountCents, shippingName, dropName }) {
  const total = money(amountCents);
  const greet = shippingName ? `Thank you, ${shippingName}.` : 'Thank you.';
  return `<!doctype html>
<html><body style="margin:0;background:#e9dcbb;padding:0;">
  <div style="display:none;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Your Wilhelm Cold Brew order is confirmed. Here's what happens next.&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9dcbb;">
    <tr><td align="center" style="padding:36px 18px;">
      <table role="presentation" width="100%" style="max-width:540px;background:#f7f0dd;border:1px solid #ddcfa6;border-radius:6px;">
        <tr><td style="padding:38px 42px 32px;">
          <div style="text-align:center;padding-bottom:26px;">
            <img src="${SITE}/drink/assets/wilhelm-circle.png" width="80" height="80" alt="Wilhelm Cold Brew" style="display:inline-block;border-radius:50%;border:0;"/>
            <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:3px;color:#b08a2c;margin-top:12px;">SMALL BATCH &middot; ST. LOUIS, MO</div>
          </div>
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.7;color:#241c10;">
            <p style="margin:0 0 16px;font-size:20px;color:#8a6914;">Order confirmed.</p>
            <p style="margin:0 0 16px;">${greet} Your bottle of Wilhelm Cold Brew is reserved${dropName ? ` from <strong>${dropName}</strong>` : ''}. ${total ? `We charged <strong>${total}</strong> to your card.` : ''}</p>
            <p style="margin:0 0 22px;">It's hand-packed and ships within a few business days. You'll get a note when it's on its way. If you need anything, just reply to this email.</p>
            <p style="margin:0 0 22px;color:#6b6047;">Bourbon-barrel-aged, single origin, no alcohol. Pour it over a big cube and take your time.</p>
            <p style="margin:0;">Talk soon,<br/>Ben<br/><span style="color:#8a7d5f;">Wilhelm Cold Brew</span></p>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function orderText({ amountCents, shippingName, dropName }) {
  const total = money(amountCents);
  return [
    'Order confirmed.',
    '',
    `${shippingName ? `Thank you, ${shippingName}.` : 'Thank you.'} Your bottle of Wilhelm Cold Brew is reserved${dropName ? ` from ${dropName}` : ''}.${total ? ` We charged ${total} to your card.` : ''}`,
    '',
    "It's hand-packed and ships within a few business days. You'll get a note when it's on its way. If you need anything, just reply to this email.",
    '',
    'Talk soon,',
    'Ben',
    'Wilhelm Cold Brew',
  ].join('\n');
}

export async function sendOrderConfirmation(to, meta = {}) {
  if (!transporter) { console.warn('[mail] skip order confirmation (SMTP not configured):', to); return; }
  const token = mkToken();
  await transporter.sendMail({
    from: FROM, to, subject: ORDER_SUBJECT,
    html: finalize(orderHtml(meta), token),
    text: orderText(meta),
  });
  await recordSend(token, to, 'order', null);
  console.log('[mail] order confirmation sent to', to);
}

// ───────── Shipping notification (tracking) ─────────
// The copy is editable from the admin (stored in settings/ship_email); these are
// the fallback defaults, and also what "Reset to default" restores. Body/subject
// support tokens: {{first_name}} {{drop}} {{tracking}} {{carrier}}.
export const SHIP_EMAIL_DEFAULTS = {
  subject: 'Your Wilhelm order is on its way',
  heading: "It's on its way.",
  body: "Hi {{first_name}}, it's packed and shipped{{drop}}. Track it anytime:",
  signoff: 'Talk soon,\nBen\nWilhelm Cold Brew',
};

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Build a carrier tracking URL from the number + (optional) carrier name. Pirate
// Ship is mostly USPS, so that's the default when the carrier is unknown.
export function trackingUrl(num, carrier) {
  const n = String(num || '').replace(/\s+/g, '');
  const c = String(carrier || '').toLowerCase();
  if (c.includes('ups') || /^1z/i.test(n)) return 'https://www.ups.com/track?tracknum=' + encodeURIComponent(n);
  if (c.includes('fedex')) return 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(n);
  if (c.includes('dhl')) return 'https://www.dhl.com/us-en/home/tracking.html?tracking-id=' + encodeURIComponent(n);
  return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(n);
}

// A shipment is one or more boxes. Split orders (one box per bottle) pass
// meta.trackings = [{tracking, carrier}, …]; everything else keeps the single
// tracking/carrier fields. This normalizes both shapes to a non-empty list.
function shipBoxes(meta = {}) {
  const list = Array.isArray(meta.trackings) && meta.trackings.length
    ? meta.trackings
    : [{ tracking: meta.tracking, carrier: meta.carrier }];
  return list.filter((b) => b && b.tracking != null && String(b.tracking).trim() !== '');
}

// Token values from the order meta. first_name falls back to "there" so a
// greeting always reads; drop includes its own " from …" so it can be dropped in.
function shipTokens(meta = {}) {
  const { shippingName, dropName } = meta;
  const boxes = shipBoxes(meta);
  const first = shippingName ? String(shippingName).trim().split(/\s+/)[0] : '';
  return {
    first_name: first || 'there',
    drop: dropName ? ` from ${dropName}` : '',
    tracking: boxes.map((b) => String(b.tracking)).join(' · '),
    carrier: boxes[0]?.carrier ? String(boxes[0].carrier).toUpperCase() : '',
  };
}
function fillTokens(text, tokens, esc) {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (m, k) =>
    (k in tokens) ? (esc ? escHtml(tokens[k]) : tokens[k]) : m);
}
// Merge a stored/draft template over the defaults (missing fields fall back).
function mergeShipTpl(tpl) { return { ...SHIP_EMAIL_DEFAULTS, ...(tpl || {}) }; }

// Load the saved shipping-email template (or defaults if none saved / DB down).
export async function getShipTemplate() {
  try {
    const r = await q(`SELECT value FROM settings WHERE key = 'ship_email'`);
    return mergeShipTpl(r.rows[0]?.value);
  } catch (e) { console.warn('[mail] ship template load failed, using defaults:', e?.message || e); return { ...SHIP_EMAIL_DEFAULTS }; }
}

function shipHtml(meta, tpl) {
  const t = mergeShipTpl(tpl);
  const tokens = shipTokens(meta);
  const boxes = shipBoxes(meta);
  // One button + tracking line per box; multi-box shipments label them Box 1/2.
  const trackBlocks = boxes.map((b, i) => {
    const url = trackingUrl(b.tracking, b.carrier);
    const label = boxes.length > 1 ? `Track box ${i + 1} &rarr;` : 'Track your package &rarr;';
    const carrierLabel = b.carrier ? String(b.carrier).toUpperCase() : 'the carrier';
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 10px;"><tr><td style="border-radius:6px;background:#8a6914;">
              <a href="${url}" style="display:inline-block;padding:13px 26px;font-family:Arial,sans-serif;font-size:15px;color:#f7f0dd;text-decoration:none;font-weight:bold;">${label}</a>
            </td></tr></table>
            <p style="margin:0 0 18px;font-family:Arial,sans-serif;font-size:13px;color:#6b6047;">${boxes.length > 1 ? `Box ${i + 1} — ` : ''}${carrierLabel} tracking: <strong>${escHtml(String(b.tracking))}</strong></p>`;
  }).join('');
  const multiNote = boxes.length > 1
    ? `<p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:13px;color:#6b6047;">Your order ships as ${boxes.length} separate boxes — they may arrive a day apart.</p>` : '';
  const bodyHtml = String(t.body || '').split(/\n{2,}/).map((para) =>
    `<p style="margin:0 0 16px;">${fillTokens(para, tokens, true).replace(/\n/g, '<br/>')}</p>`).join('');
  const signoffHtml = fillTokens(t.signoff, tokens, true).replace(/\n/g, '<br/>');
  return `<!doctype html>
<html><body style="margin:0;background:#e9dcbb;padding:0;">
  <div style="display:none;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Your Wilhelm Cold Brew is on its way. Here's your tracking.&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9dcbb;">
    <tr><td align="center" style="padding:36px 18px;">
      <table role="presentation" width="100%" style="max-width:540px;background:#f7f0dd;border:1px solid #ddcfa6;border-radius:6px;">
        <tr><td style="padding:38px 42px 32px;">
          <div style="text-align:center;padding-bottom:26px;">
            <img src="${SITE}/drink/assets/wilhelm-circle.png" width="80" height="80" alt="Wilhelm Cold Brew" style="display:inline-block;border-radius:50%;border:0;"/>
            <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:3px;color:#b08a2c;margin-top:12px;">SMALL BATCH &middot; ST. LOUIS, MO</div>
          </div>
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.7;color:#241c10;">
            <p style="margin:0 0 16px;font-size:20px;color:#8a6914;">${fillTokens(t.heading, tokens, true)}</p>
            ${bodyHtml}
            ${multiNote}
            ${trackBlocks}
            <p style="margin:6px 0 0;">${signoffHtml}</p>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function shipText(meta, tpl) {
  const t = mergeShipTpl(tpl);
  const tokens = shipTokens(meta);
  const boxes = shipBoxes(meta);
  const trackLines = boxes.flatMap((b, i) => [
    `${boxes.length > 1 ? `Box ${i + 1} — ` : ''}${b.carrier ? String(b.carrier).toUpperCase() + ' ' : ''}tracking: ${b.tracking}`,
    `Track it: ${trackingUrl(b.tracking, b.carrier)}`,
  ]);
  return [
    fillTokens(t.heading, tokens, false),
    '',
    fillTokens(t.body, tokens, false),
    ...(boxes.length > 1 ? ['', `Your order ships as ${boxes.length} separate boxes — they may arrive a day apart.`] : []),
    '',
    ...trackLines,
    '',
    fillTokens(t.signoff, tokens, false),
  ].join('\n');
}

// Render with an EXPLICIT template (for the admin's live preview of unsaved edits).
export function renderShippingEmailWith(meta = {}, tpl) {
  const t = mergeShipTpl(tpl);
  return { subject: fillTokens(t.subject, shipTokens(meta), false), html: shipHtml(meta, t), text: shipText(meta, t) };
}

// Render the shipping email (loads the saved template) without sending — admin preview.
export async function renderShippingEmail(meta = {}) {
  return renderShippingEmailWith(meta, await getShipTemplate());
}

// `record: false` sends without logging to email_sends — used by the "send test
// to me" button so a test doesn't show up in stats.
export async function sendShippingNotice(to, meta = {}, { record = true } = {}) {
  if (!transporter) { console.warn('[mail] skip shipping notice (SMTP not configured):', to); return; }
  const t = await getShipTemplate();
  const token = mkToken();
  await transporter.sendMail({
    from: FROM, to, subject: fillTokens(t.subject, shipTokens(meta), false),
    html: finalize(shipHtml(meta, t), token),
    text: shipText(meta, t),
  });
  if (record) await recordSend(token, to, 'shipping', null);
  console.log('[mail] shipping notice sent to', to, record ? '' : '(test)');
}

// Internal "new order" alert to Ben. Plain, untracked, not logged to email_sends.
export async function sendOrderAlert({ email, amountCents, dropName, shippingName }) {
  if (!transporter || !SIGNUP_NOTIFY) return;
  const lines = [
    'New order:',
    '',
    `  Email:    ${email || '(unknown)'}`,
    amountCents != null ? `  Total:    ${money(amountCents)}` : null,
    shippingName ? `  Ship to:  ${shippingName}` : null,
    dropName ? `  Drop:     ${dropName}` : null,
    '',
    `See orders: ${SITE}/admin`,
  ].filter((l) => l !== null);
  try {
    await transporter.sendMail({
      from: FROM, to: SIGNUP_NOTIFY,
      subject: `New order: ${email || 'Wilhelm Cold Brew'}`,
      text: lines.join('\n'),
    });
    console.log('[mail] order alert sent for', email);
  } catch (e) {
    console.warn('[mail] order alert failed:', e?.message || e);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const htmlToText = (html) => String(html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Account-level provider block (vs. a per-recipient failure). Gmail returns these
// when it rate-limits the whole account — retrying only deepens the lockout, so
// when we see one we STOP the blast and leave the remainder cleanly resendable.
function isProviderBlock(e) {
  if (!e) return false;
  if (e.responseCode === 421 || e.responseCode === 454) return true;
  const msg = String(e.response || e.message || '').toLowerCase();
  return /4\.7\.0|too many login|too many messages|rate limit|quota exceeded|try again later|temporarily|unusual (sending|activity)|throttl/.test(msg);
}

// Throttled blast to a list. The pooled transporter handles connection reuse;
// here we pace per-message and, critically, BAIL on an account-level rate-limit
// block instead of hammering. Returns per-recipient results plus `unsent`/`stopped`
// so the caller can mark the remainder and resend later.
export async function sendBulk(recipients, subject, html, opts) {
  if (!transporter) throw new Error('SMTP not configured');
  const delayMs = (opts && opts.delayMs) || 600;
  // Safety ceiling per run — high enough to cover the whole list in one go.
  // (Was 400, which silently dropped everyone past the oldest 400 subscribers.)
  const cap = (opts && opts.cap) || 5000;
  const blastId = opts && opts.blastId;
  const onProgress = opts && opts.onProgress;
  const text = htmlToText(html);
  const results = [];
  let sent = 0, failed = 0;
  let stopped = null;                 // reason string if we bail early on a block
  const n = Math.min(recipients.length, cap);
  let i = 0;
  for (; i < n; i++) {
    const to = recipients[i];
    const token = mkToken();
    const send = () => transporter.sendMail({
      from: FROM, to, subject,
      html: finalize(html + blastFooter(token), token),
      text: text + '\n\nUnsubscribe: ' + unsubUrl(token),
      headers: unsubHeaders(token),
    });
    try {
      try {
        await send();
      } catch (e1) {
        // An account-level block won't clear in 3s — don't retry it, surface it
        // so the outer catch can stop the run. Only retry genuine transients.
        if (isProviderBlock(e1)) throw e1;
        await wait(3000);
        await send();
      }
      // Only now — after the message is genuinely out — record it as sent.
      await recordSend(token, to, 'blast', blastId);
      sent++; results.push({ to, ok: true });
    } catch (e) {
      if (isProviderBlock(e)) {
        // Provider locked us out. Stop here; everyone from i onward is untouched
        // and resendable (none of them were recorded as sent).
        stopped = e.response || e.message || 'provider rate limit';
        results.push({ to, ok: false, error: e.message, blocked: true });
        break;
      }
      failed++; results.push({ to, ok: false, error: e.message });
    }
    if (onProgress) { try { onProgress({ sent, failed, i: i + 1, n }); } catch (_) {} }
    if (i < n - 1) await wait(delayMs);
  }
  // Anyone never attempted (we stopped early) — distinct from a real failure.
  const unsent = n - sent - failed;
  if (stopped) console.warn(`[mail] blast stopped early after ${sent} sent — provider block: ${stopped}`);
  return { sent, failed, unsent, stopped, attempted: sent + failed, total: recipients.length, results };
}
