// Transactional email via SMTP (nodemailer). Sends from ben@wilhelmcoldbrew.com.
import nodemailer from 'nodemailer';

const HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const FROM = process.env.MAIL_FROM || 'Wilhelm Cold Brew <ben@wilhelmcoldbrew.com>';

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
const WELCOME_SUBJECT = 'You made the list';

function welcomeHtml() {
  return `<!doctype html>
<html><body style="margin:0;background:#0c0a08;padding:0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0c0a08;">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" width="100%" style="max-width:520px;font-family:Georgia,'Times New Roman',serif;color:#e8d9b5;">
        <tr><td style="text-align:center;padding-bottom:24px;">
          <div style="font-family:Georgia,serif;font-size:24px;letter-spacing:3px;color:#e8c24a;font-weight:bold;">WILHELM COLD BREW</div>
          <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:3px;color:rgba(232,217,181,0.6);margin-top:6px;">SMALL BATCH · ST. LOUIS, MO</div>
        </td></tr>
        <tr><td style="font-size:17px;line-height:1.65;color:#e8d9b5;">
          <p style="margin:0 0 16px;font-size:22px;color:#e8c24a;">You made the list.</p>
          <p style="margin:0 0 24px;">Welcome in. Every <strong style="color:#fff;">Friday at 9AM</strong> the drop link hits your inbox. Fewer than 100 bottles, and they go fast, so when it lands, don't wait.</p>
          <p style="margin:0;color:rgba(232,217,181,0.85);">Talk soon,<br/>Ben<br/><span style="color:rgba(232,217,181,0.6);">Wilhelm Cold Brew</span></p>
        </td></tr>
        <tr><td style="padding-top:28px;border-top:1px solid rgba(232,194,74,0.2);margin-top:24px;font-family:Arial,sans-serif;font-size:11px;color:rgba(232,217,181,0.45);">
          You're receiving this because you joined the Wilhelm Cold Brew Friday Drop list. Reply "stop" to unsubscribe.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function welcomeText() {
  return [
    'You made the list.',
    '',
    "Welcome in. Every Friday at 9AM the drop link hits your inbox. Fewer than 100 bottles, and they go fast, so when it lands, don't wait.",
    '',
    'Talk soon,',
    'Ben',
    'Wilhelm Cold Brew',
  ].join('\n');
}

export async function sendWelcome(to) {
  if (!transporter) { console.warn('[mail] skip welcome (SMTP not configured):', to); return; }
  await transporter.sendMail({
    from: FROM,
    to,
    subject: WELCOME_SUBJECT,
    html: welcomeHtml(),
    text: welcomeText(),
  });
  console.log('[mail] welcome sent to', to);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const htmlToText = (html) => String(html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Throttled blast to a list. Gmail/Workspace rate-limits rapid sends, so we pace
// them and cap per run; returns per-recipient results so failures can be retried.
export async function sendBulk(recipients, subject, html, opts) {
  if (!transporter) throw new Error('SMTP not configured');
  const delayMs = (opts && opts.delayMs) || 600;
  const cap = (opts && opts.cap) || 400; // safety ceiling per run
  const text = htmlToText(html);
  const results = [];
  let sent = 0, failed = 0;
  const n = Math.min(recipients.length, cap);
  for (let i = 0; i < n; i++) {
    const to = recipients[i];
    try {
      await transporter.sendMail({ from: FROM, to, subject, html, text });
      sent++; results.push({ to, ok: true });
    } catch (e) {
      failed++; results.push({ to, ok: false, error: e.message });
    }
    if (i < n - 1) await wait(delayMs);
  }
  return { sent, failed, attempted: n, total: recipients.length, results };
}
