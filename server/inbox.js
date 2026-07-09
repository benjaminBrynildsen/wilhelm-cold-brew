// Inbox sync: pulls customer email conversations into email_messages over IMAP,
// for the admin's Thank-you tab. Reuses the SMTP (Gmail) credentials by default —
// set IMAP_HOST / IMAP_USER / IMAP_PASS / IMAP_SENT to override.
//
// Only messages to/from KNOWN customers (subscribers or order emails) are stored,
// so receipts, notifications, and spam never enter the database. Deduped by RFC
// Message-ID; every failure is soft (the tab just shows what's already synced).
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { q } from './db.js';

const HOST = process.env.IMAP_HOST || 'imap.gmail.com';
const PORT = +(process.env.IMAP_PORT || 993);
const USER = process.env.IMAP_USER || process.env.SMTP_USER;
const PASS = process.env.IMAP_PASS || process.env.SMTP_PASS;
const SENT_FOLDER = process.env.IMAP_SENT || '[Gmail]/Sent Mail';
const LOOKBACK_DAYS = +(process.env.IMAP_LOOKBACK_DAYS || 365);
const MAX_PER_SYNC = 400;   // per folder, newest first — a runaway-inbox guard

export const inboxConfigured = () => !!(USER && PASS);

let syncing = false;
let lastSyncAt = 0;
export const inboxSyncState = () => ({ configured: inboxConfigured(), syncing, lastSyncAt });

// Addresses we consider "us" (never a customer).
const OWN = new Set([String(USER || '').toLowerCase(), 'ben@wilhelmcoldbrew.com', 'benbrynildsen5757@gmail.com']);

async function knownCustomers() {
  const rows = (await q(`
    SELECT LOWER(email) e FROM subscribers
    UNION SELECT LOWER(email) FROM orders WHERE email IS NOT NULL`)).rows;
  return new Set(rows.map((r) => r.e));
}

// Strip quoted history so the card shows what was actually written.
function stripQuotes(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^On .{5,80} wrote:\s*$/.test(l.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}

async function syncFolder(client, folder, direction, known) {
  const lock = await client.getMailboxLock(folder);
  let stored = 0;
  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
    let uids = await client.search({ since }, { uid: true });
    if (!uids || !uids.length) return 0;
    uids = uids.slice(-MAX_PER_SYNC);
    for await (const msg of client.fetch(uids, { uid: true, envelope: true, source: true }, { uid: true })) {
      try {
        const env = msg.envelope;
        const mid = env.messageId || `imap:${folder}:${msg.uid}`;
        const from = (env.from?.[0]?.address || '').toLowerCase();
        const tos = (env.to || []).map((a) => (a.address || '').toLowerCase());
        // the counterpart: sender for inbox mail, first known recipient for sent mail
        const counterpart = direction === 'in' ? from : (tos.find((t) => known.has(t)) || tos[0] || '');
        if (!counterpart || OWN.has(counterpart) || !known.has(counterpart)) continue;
        const dup = await q(`SELECT 1 FROM email_messages WHERE message_id = $1`, [mid]);
        if (dup.rows.length) continue;
        const parsed = await simpleParser(msg.source);
        const body = stripQuotes(parsed.text || parsed.html?.replace(/<[^>]+>/g, ' ') || '');
        await q(
          `INSERT INTO email_messages (message_id, customer_email, direction, subject, body, sent_at)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (message_id) DO NOTHING`,
          [mid, counterpart, direction, (env.subject || '').slice(0, 300), body, env.date || new Date()]);
        stored++;
      } catch (e) { console.warn('[inbox] message skipped:', e?.message || e); }
    }
  } finally { lock.release(); }
  return stored;
}

export async function syncInbox() {
  if (!inboxConfigured()) return { ok: false, error: 'IMAP not configured (set IMAP_USER / IMAP_PASS or SMTP creds)' };
  if (syncing) return { ok: true, alreadyRunning: true };
  syncing = true;
  const client = new ImapFlow({
    host: HOST, port: PORT, secure: true,
    auth: { user: USER, pass: PASS },
    logger: false,
  });
  try {
    const known = await knownCustomers();
    await client.connect();
    const inbox = await syncFolder(client, 'INBOX', 'in', known);
    let sent = 0;
    try { sent = await syncFolder(client, SENT_FOLDER, 'out', known); }
    catch (e) { console.warn(`[inbox] sent folder "${SENT_FOLDER}" failed:`, e?.message || e); }
    lastSyncAt = Date.now();
    return { ok: true, stored: { inbox, sent } };
  } catch (e) {
    console.warn('[inbox] sync failed:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  } finally {
    syncing = false;
    await client.logout().catch(() => client.close());
  }
}
