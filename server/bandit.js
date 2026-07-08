// Split-test autopilot: shifts new-visitor traffic toward the arms that are
// converting, per test (image / background / headline / proof), while every
// live arm keeps a floor share so it can keep proving itself.
//
// How allocation works (Thompson sampling): each arm's conversion rate is a
// Beta distribution over its RECENCY-DECAYED landed/joined counts (half-life
// ~3 days, so today's traffic counts full and last week barely counts). We
// draw from every arm's distribution a few thousand times; an arm's traffic
// share is how often it wins the draw. Little data → wide distributions →
// near-even split. A clear winner → most of the traffic. A winner that stops
// converting → its distribution sags within days and traffic rotates away.
//
// Auto-pause (the kill switch) uses RAW counts, not decayed ones: an arm is
// only turned off when it has real volume (killMinSessions) and its 95%
// confidence interval sits entirely below the leader's — i.e. it's losing on
// evidence, not noise. Paused arms are flagged in the admin and can be revived.
//
// Everything fails open: any error → null weights → the page's even split.
import { q } from './db.js';

const DRINK_PAGES = ['/drink/', '/drink'];
const EXCL = `AND ip_hash NOT IN (SELECT ip_hash FROM internal_ips) AND (data->>'is_internal') IS DISTINCT FROM 'true'`;
const REPORT_TZ = 'America/Chicago';

// Which journey_events dimension each test reads (constants — safe to inline).
const TEST_EXPR = {
  image: 'variant',
  background: `data->>'bg'`,
  headline: `data->>'hl'`,
  proof: `data->>'proof'`,
};
export const BANDIT_TESTS = Object.keys(TEST_EXPR);

export const BANDIT_DEFAULTS = {
  enabled: true,
  halfLifeDays: 3,       // decay half-life: 3-day-old traffic counts half of today's
  floorPct: 10,          // every live arm keeps ≥ this % of new-visitor traffic
  lookbackDays: 28,      // how far back the bandit looks at all
  killEnabled: true,
  killMinSessions: 300,  // raw sessions before an arm may be auto-paused
  // Champion pool: a slice of new-visitor traffic reserved for PROVEN full
  // recipes (image × background × headline served as a unit), Thompson-sampled
  // against each other. Catches interactions the per-dimension bandits can't
  // (a headline that only works next to a particular photo).
  comboEnabled: true,
  comboPct: 25,          // % of new-visitor traffic the pool may use
  comboMinSessions: 150, // raw sessions a combo needs before it can enter the pool
  comboMax: 4,           // pool size cap — keeps each champion's traffic meaningful
};

const TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, state: null };
export function bustBanditCache() { cache = { at: 0, state: null }; }

function centralDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// ── sampling helpers ──
function normal() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function gammaSample(shape) {
  if (shape < 1) return gammaSample(shape + 1) * Math.pow(Math.random() || 1e-12, 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = normal(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const betaSample = (a, b) => { const x = gammaSample(a); return x / (x + gammaSample(b)); };

// 95% Wilson score interval — the kill rule's evidence bar.
function wilson(k, n, z = 1.96) {
  if (!n) return { lo: 0, hi: 1 };
  const p = k / n, z2 = z * z, den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

async function loadConfig() {
  try {
    const row = (await q(`SELECT value FROM settings WHERE key = 'bandit_config'`)).rows[0];
    return { ...BANDIT_DEFAULTS, ...(row?.value || {}) };
  } catch { return { ...BANDIT_DEFAULTS }; }
}

// Per-arm, per-Central-day landed/joined for one test dimension.
async function dailyCounts(testId, lookbackDays) {
  const expr = TEST_EXPR[testId];
  const rows = (await q(
    `WITH s AS (
       SELECT session_id, MAX(${expr}) arm, MIN(created_at) started,
              BOOL_OR(event = 'subscribed') joined
         FROM journey_events
        WHERE page = ANY($1) AND created_at >= now() - ($2 || ' days')::interval ${EXCL}
        GROUP BY session_id
     )
     SELECT arm, TO_CHAR(started AT TIME ZONE '${REPORT_TZ}', 'YYYY-MM-DD') AS day,
            COUNT(*)::int landed, COUNT(*) FILTER (WHERE joined)::int joined
       FROM s WHERE arm IS NOT NULL
      GROUP BY arm, day`,
    [DRINK_PAGES, String(lookbackDays)]
  )).rows;
  const byArm = {};
  for (const r of rows) {
    const a = (byArm[r.arm] = byArm[r.arm] || { days: {}, landed: 0, joined: 0 });
    a.days[r.day] = { landed: r.landed, joined: r.joined };
    a.landed += r.landed; a.joined += r.joined;
  }
  return byArm;
}

// Per-combo (image × background × headline), per-Central-day landed/joined.
// Sessions missing any of the three tags don't count toward any combo.
async function comboDailyCounts(lookbackDays) {
  const rows = (await q(
    `WITH s AS (
       SELECT session_id, MAX(variant) img, MAX(data->>'bg') bg, MAX(data->>'hl') hl,
              MIN(created_at) started, BOOL_OR(event = 'subscribed') joined
         FROM journey_events
        WHERE page = ANY($1) AND created_at >= now() - ($2 || ' days')::interval ${EXCL}
        GROUP BY session_id
     )
     SELECT img, bg, hl, TO_CHAR(started AT TIME ZONE '${REPORT_TZ}', 'YYYY-MM-DD') AS day,
            COUNT(*)::int landed, COUNT(*) FILTER (WHERE joined)::int joined
       FROM s WHERE img IS NOT NULL AND bg IS NOT NULL AND hl IS NOT NULL
      GROUP BY img, bg, hl, day`,
    [DRINK_PAGES, String(lookbackDays)]
  )).rows;
  const byCombo = {};
  for (const r of rows) {
    const key = `${r.img}|${r.bg}|${r.hl}`;
    const c = (byCombo[key] = byCombo[key] || { image: r.img, bg: r.bg, hl: r.hl, days: {}, landed: 0, joined: 0 });
    c.days[r.day] = { landed: r.landed, joined: r.joined };
    c.landed += r.landed; c.joined += r.joined;
  }
  return byCombo;
}

// Combo layer: manual pins + the autopilot's champion pool. Returns the slice
// of new-visitor traffic that gets a FULL recipe instead of independent picks.
// Pins are explicit admin intent, so they serve even with the autopilot off.
async function computeCombos(cfg, armRows, today) {
  const pins = (await q(`SELECT image, bg, hl, pin_pct FROM split_combos ORDER BY pin_pct DESC, image, bg, hl`)
    .catch(() => ({ rows: [] }))).rows;
  const counts = await comboDailyCounts(cfg.lookbackDays).catch(() => ({}));
  const liveArm = new Set(armRows.filter((r) => r.enabled).map((r) => `${r.test_id}:${r.arm_key}`));

  const decay = (days) => {
    let dl = 0, dj = 0;
    for (const [day, v] of Object.entries(days)) {
      const daysAgo = Math.max(0, (Date.parse(today) - Date.parse(day)) / 86400000);
      const w = Math.pow(0.5, daysAgo / Math.max(0.5, cfg.halfLifeDays));
      dl += v.landed * w; dj += v.joined * w;
    }
    return { dl, dj };
  };
  const entry = (image, bg, hl, source) => {
    const c = counts[`${image}|${bg}|${hl}`] || { days: {}, landed: 0, joined: 0 };
    const { dl, dj } = decay(c.days);
    return { image, bg, hl, source, weight: 0, landed: c.landed, joined: c.joined,
             decayedLanded: dl, decayedJoined: dj, days: c.days };
  };

  // Manual pins first. Scale down proportionally if they somehow sum past 100%
  // (the save endpoint also guards this) so the recipe roll stays a probability.
  const entries = pins.map((p) => ({ ...entry(p.image, p.bg, p.hl, 'pin'), pinPct: p.pin_pct }));
  let pinTotal = entries.reduce((s, e) => s + Math.max(0, Math.min(100, e.pinPct)) / 100, 0);
  const pinScale = pinTotal > 1 ? 1 / pinTotal : 1;
  entries.forEach((e) => { e.weight = Math.round(Math.max(0, Math.min(100, e.pinPct)) / 100 * pinScale * 1000) / 1000; });
  pinTotal = Math.min(1, pinTotal);

  // Champion pool: proven combos (enough raw sessions, every arm still live,
  // not already pinned) Thompson-sampled against each other for the pool share.
  const poolShare = cfg.enabled && cfg.comboEnabled
    ? Math.max(0, Math.min(cfg.comboPct / 100, 1 - pinTotal)) : 0;
  if (poolShare > 0) {
    const pinned = new Set(pins.map((p) => `${p.image}|${p.bg}|${p.hl}`));
    const pool = Object.entries(counts)
      .filter(([key, c]) => !pinned.has(key)
        && c.landed >= cfg.comboMinSessions
        && liveArm.has(`image:${c.image}`) && liveArm.has(`background:${c.bg}`) && liveArm.has(`headline:${c.hl}`))
      .map(([, c]) => entry(c.image, c.bg, c.hl, 'pool'))
      .sort((a, b) => (b.decayedJoined / Math.max(1, b.decayedLanded)) - (a.decayedJoined / Math.max(1, a.decayedLanded)))
      .slice(0, Math.max(1, cfg.comboMax));
    if (pool.length === 1) {
      pool[0].weight = Math.round(poolShare * 1000) / 1000;
    } else if (pool.length > 1) {
      const DRAWS = 3000;
      const wins = new Array(pool.length).fill(0);
      for (let i = 0; i < DRAWS; i++) {
        let bi = 0, bv = -1;
        for (let j = 0; j < pool.length; j++) {
          const v = betaSample(1 + pool[j].decayedJoined, 1 + Math.max(0, pool[j].decayedLanded - pool[j].decayedJoined));
          if (v > bv) { bv = v; bi = j; }
        }
        wins[bi]++;
      }
      pool.forEach((e, j) => { e.weight = Math.round(poolShare * (wins[j] / DRAWS) * 1000) / 1000; });
    }
    entries.push(...pool.filter((e) => e.weight > 0));
  }

  return { pinTotal: Math.round(pinTotal * 1000) / 1000, poolShare: Math.round(poolShare * 1000) / 1000, entries };
}

// Full recompute: weights per test + auto-pause pass + daily snapshot.
async function compute() {
  const cfg = await loadConfig();
  const armRows = (await q(
    `SELECT test_id, arm_key, enabled, auto_paused_at, auto_reason, revived_at FROM split_arms ORDER BY test_id, sort, arm_key`
  )).rows;
  const today = centralDay();
  const state = { config: cfg, computedAt: new Date().toISOString(), tests: {} };

  for (const testId of BANDIT_TESTS) {
    const arms = armRows.filter((r) => r.test_id === testId);
    if (!arms.length) continue;
    const counts = await dailyCounts(testId, cfg.lookbackDays);

    // Recency-decayed counts per arm.
    const detail = arms.map((a) => {
      const c = counts[a.arm_key] || { days: {}, landed: 0, joined: 0 };
      let dl = 0, dj = 0;
      for (const [day, v] of Object.entries(c.days)) {
        const daysAgo = Math.max(0, (Date.parse(today) - Date.parse(day)) / 86400000);
        const w = Math.pow(0.5, daysAgo / Math.max(0.5, cfg.halfLifeDays));
        dl += v.landed * w; dj += v.joined * w;
      }
      // Kill-rule evidence: only days since the last manual revive count, so a
      // revived arm can't be re-paused on the history that got it paused before.
      const revDay = a.revived_at ? centralDay(new Date(a.revived_at)) : null;
      let kl = c.landed, kj = c.joined;
      if (revDay) {
        kl = 0; kj = 0;
        for (const [day, v] of Object.entries(c.days)) {
          if (day >= revDay) { kl += v.landed; kj += v.joined; }
        }
      }
      return {
        key: a.arm_key, enabled: a.enabled,
        auto_paused_at: a.auto_paused_at, auto_reason: a.auto_reason, revived_at: a.revived_at,
        landed: c.landed, joined: c.joined, days: c.days,
        killLanded: kl, killJoined: kj,
        decayedLanded: dl, decayedJoined: dj,
      };
    });

    // Thompson allocation across LIVE arms only.
    const live = detail.filter((d) => d.enabled);
    const weights = {};
    if (live.length >= 2 && cfg.enabled) {
      const DRAWS = 3000;
      const wins = new Array(live.length).fill(0);
      for (let i = 0; i < DRAWS; i++) {
        let bi = 0, bv = -1;
        for (let j = 0; j < live.length; j++) {
          const v = betaSample(1 + live[j].decayedJoined, 1 + Math.max(0, live[j].decayedLanded - live[j].decayedJoined));
          if (v > bv) { bv = v; bi = j; }
        }
        wins[bi]++;
      }
      const floor = Math.min(0.9 / live.length, Math.max(0, cfg.floorPct / 100));
      const scale = 1 - floor * live.length;
      live.forEach((d, j) => { weights[d.key] = Math.round((floor + scale * (wins[j] / DRAWS)) * 1000) / 1000; });
    } else if (live.length) {
      live.forEach((d) => { weights[d.key] = Math.round(1000 / live.length) / 1000; });
    }
    detail.forEach((d) => { d.weight = weights[d.key] ?? 0; });

    // Kill rule (raw counts): loser's 95% CI entirely below the leader's.
    if (cfg.enabled && cfg.killEnabled && live.length > 2) {
      const bench = live.filter((d) => d.landed >= 100);
      const leader = bench.sort((a, b) => (b.joined / Math.max(1, b.landed)) - (a.joined / Math.max(1, a.landed)))[0];
      if (leader) {
        const lo = wilson(leader.joined, leader.landed).lo;
        let liveCount = live.length;
        for (const d of live) {
          if (d === leader || liveCount <= 2) continue;
          if (d.killLanded >= cfg.killMinSessions && wilson(d.killJoined, d.killLanded).hi < lo) {
            const reason = `auto-paused: ${d.killJoined}/${d.killLanded} (${((d.killJoined / d.killLanded) * 100).toFixed(1)}%) is below “${leader.key}” (${((leader.joined / leader.landed) * 100).toFixed(1)}%) with 95% confidence`;
            await q(`UPDATE split_arms SET enabled = false, auto_paused_at = now(), auto_reason = $3 WHERE test_id = $1 AND arm_key = $2`,
              [testId, d.key, reason]).catch((e) => console.warn('[bandit] pause failed:', e?.message || e));
            d.enabled = false; d.auto_paused_at = new Date().toISOString(); d.auto_reason = reason; d.weight = 0;
            liveCount--;
            console.log(`[bandit] ${testId}/${d.key} ${reason}`);
          }
        }
      }
    }

    state.tests[testId] = { arms: detail };

    // Daily snapshot — one row per (day, test, arm), refreshed through the day,
    // so the admin can replay what the autopilot saw and decided each day.
    for (const d of detail) {
      const t = d.days[today] || { landed: 0, joined: 0 };
      q(`INSERT INTO bandit_log (day, test_id, arm_key, weight, landed, joined)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (day, test_id, arm_key) DO UPDATE SET weight=$4, landed=$5, joined=$6, updated_at=now()`,
        [today, testId, d.key, d.weight, t.landed, t.joined])
        .catch((e) => console.warn('[bandit] log failed:', e?.message || e));
    }
  }

  // Combo layer (pins + champion pool). Fails soft: any error → no combo slice,
  // per-dimension serving continues untouched.
  try {
    state.combos = await computeCombos(cfg, armRows, today);
    for (const e of state.combos.entries) {
      const t = e.days[today] || { landed: 0, joined: 0 };
      q(`INSERT INTO bandit_log (day, test_id, arm_key, weight, landed, joined)
         VALUES ($1,'combo',$2,$3,$4,$5)
         ON CONFLICT (day, test_id, arm_key) DO UPDATE SET weight=$3, landed=$4, joined=$5, updated_at=now()`,
        [today, `${e.image}|${e.bg}|${e.hl}`, e.weight, t.landed, t.joined])
        .catch((err) => console.warn('[bandit] combo log failed:', err?.message || err));
    }
  } catch (e) {
    console.warn('[bandit] combo layer failed (per-dimension serving unaffected):', e?.message || e);
    state.combos = { pinTotal: 0, poolShare: 0, entries: [] };
  }
  return state;
}

async function getState() {
  if (cache.state && Date.now() - cache.at < TTL_MS) return cache.state;
  const state = await compute();
  cache = { at: Date.now(), state };
  return state;
}

// For the /drink page: { image: {cigars: .58, …}, background: {…}, … } or null
// when the autopilot is off (page falls back to its even split).
export async function getBanditWeights() {
  try {
    const s = await getState();
    if (!s.config.enabled) return null;
    const out = {};
    for (const [testId, t] of Object.entries(s.tests)) {
      const live = t.arms.filter((a) => a.enabled);
      if (live.length >= 2) out[testId] = Object.fromEntries(live.map((a) => [a.key, a.weight]));
    }
    return Object.keys(out).length ? out : null;
  } catch (e) {
    console.warn('[bandit] weights failed (falling back to even split):', e?.message || e);
    return null;
  }
}

// For the /drink page: [{image, bg, hl, w}, …] — the recipes (pinned + champion
// pool) that get served as a unit to that share of new visitors — or null when
// there are none. Pins serve even with the autopilot off; only the pool gates
// on it (see computeCombos).
export async function getComboServe() {
  try {
    const s = await getState();
    const out = ((s.combos && s.combos.entries) || [])
      .filter((e) => e.weight > 0)
      .map((e) => ({ image: e.image, bg: e.bg, hl: e.hl, w: e.weight }));
    return out.length ? out : null;
  } catch (e) {
    console.warn('[bandit] combo serve failed (falling back to per-dimension):', e?.message || e);
    return null;
  }
}

// For the admin: full per-arm detail + the last 7 days of the decision log.
export async function getBanditReport() {
  const s = await getState();
  const log = (await q(
    `SELECT day, test_id, arm_key, weight, landed, joined FROM bandit_log
      WHERE day >= TO_CHAR((now() AT TIME ZONE '${REPORT_TZ}')::date - 6, 'YYYY-MM-DD')
      ORDER BY day`
  ).catch(() => ({ rows: [] }))).rows;
  return { ...s, log, today: centralDay() };
}
