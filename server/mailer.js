// Transactional email via SMTP (nodemailer). Sends from ben@wilhelmcoldbrew.com.
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import { q } from './db.js';

const SITE = process.env.SITE_URL || 'https://wilhelmcoldbrew.com';

// Register a send and return its open-tracking token.
async function registerSend(email, kind, blastId) {
  const token = crypto.randomBytes(16).toString('hex');
  try {
    await q(`INSERT INTO email_sends (token, email, kind, blast_id) VALUES ($1,$2,$3,$4)`,
      [token, email, kind, blastId || null]);
  } catch (e) { console.warn('[mail] registerSend failed:', e?.message || e); }
  return token;
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
// Defaults to the sending account; override with SIGNUP_NOTIFY for a personal inbox.
const SIGNUP_NOTIFY = process.env.SIGNUP_NOTIFY || USER;

let transporter = null;
if (USER && PASS) {
  transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: PORT === 465,
    auth: { user: USER, pass: PASS },
  });
  console.log('[mail] SMTP configured as', USER);
} else {
  console.warn('[mail] SMTP not configured (SMTP_USER/SMTP_PASS missing) — emails will be skipped.');
}

export function mailReady() { return !!transporter; }

// ───────── Welcome email (sent on each new signup) ─────────
const WELCOME_SUBJECT = "You're in...";

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
            <p style="margin:0 0 16px;">Welcome in. Here's how the Friday Drop works: every <strong style="color:#8a6914;">Friday at 9AM</strong> the purchase link lands in your inbox. We make fewer than 100 bottles a batch, single-origin and bourbon-barrel-aged, and they go fast. When you see the email, move quick. Blink and they're gone.</p>
            <p style="margin:0 0 16px;">A little on the name. Wilhelm was my great-great-grandfather. He crossed from Norway with his wife and a few kids and almost nothing else, set up shop on Court Street in Brooklyn, and made his living first by hand-stitching gloves, then by turning that same shop into a music studio where all eight of his sons learned an instrument. A whole house built on patience and craft.</p>
            <p style="margin:0 0 22px;">That's the same idea in every bottle: small batches, no shortcuts, and a roast that changes week to week so there's always a reason to come back. No alcohol, just the deep barrel-aged character.</p>
            <p style="margin:0 0 22px;color:#6b6047;">No spam between drops. Just the Friday email when the next batch is ready.</p>
            <p style="margin:0;">Talk soon,<br/>Ben<br/><span style="color:#8a7d5f;">Wilhelm Cold Brew</span></p>
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
    "Welcome in. Here's how the Friday Drop works: every Friday at 9AM the purchase link lands in your inbox. We make fewer than 100 bottles a batch, single-origin and bourbon-barrel-aged, and they go fast. When you see the email, move quick. Blink and they're gone.",
    '',
    'A little on the name. Wilhelm was my great-great-grandfather. He crossed from Norway with his wife and a few kids and almost nothing else, set up shop on Court Street in Brooklyn, and made his living first by hand-stitching gloves, then by turning that same shop into a music studio where all eight of his sons learned an instrument. A whole house built on patience and craft.',
    '',
    "That's the same idea in every bottle: small batches, no shortcuts, and a roast that changes week to week so there's always a reason to come back. No alcohol, just the deep barrel-aged character.",
    '',
    'No spam between drops. Just the Friday email when the next batch is ready.',
    '',
    'Talk soon,',
    'Ben',
    'Wilhelm Cold Brew',
  ].join('\n');
}

export async function sendWelcome(to) {
  if (!transporter) { console.warn('[mail] skip welcome (SMTP not configured):', to); return; }
  const token = await registerSend(to, 'welcome', null);
  await transporter.sendMail({
    from: FROM,
    to,
    subject: WELCOME_SUBJECT,
    html: finalize(welcomeHtml(), token),
    text: welcomeText() + '\n\nUnsubscribe: ' + unsubUrl(token),
    headers: unsubHeaders(token),
  });
  console.log('[mail] welcome sent to', to);
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const htmlToText = (html) => String(html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Throttled blast to a list. Gmail/Workspace rate-limits rapid sends, so we pace
// them and cap per run; returns per-recipient results so failures can be retried.
export async function sendBulk(recipients, subject, html, opts) {
  if (!transporter) throw new Error('SMTP not configured');
  const delayMs = (opts && opts.delayMs) || 600;
  const cap = (opts && opts.cap) || 400; // safety ceiling per run
  const blastId = opts && opts.blastId;
  const text = htmlToText(html);
  const results = [];
  let sent = 0, failed = 0;
  const n = Math.min(recipients.length, cap);
  for (let i = 0; i < n; i++) {
    const to = recipients[i];
    try {
      const token = await registerSend(to, 'blast', blastId);
      await transporter.sendMail({
        from: FROM, to, subject,
        html: finalize(html + blastFooter(token), token),
        text: text + '\n\nUnsubscribe: ' + unsubUrl(token),
        headers: unsubHeaders(token),
      });
      sent++; results.push({ to, ok: true });
    } catch (e) {
      failed++; results.push({ to, ok: false, error: e.message });
    }
    if (i < n - 1) await wait(delayMs);
  }
  return { sent, failed, attempted: n, total: recipients.length, results };
}
