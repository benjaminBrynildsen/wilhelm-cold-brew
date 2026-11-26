// Human name for where a signup came from, for the owner push notification
// ("New signup from Facebook"). Reads the first-party attribution saved with the
// signup: the utm_source tag first, then an ad click id when the link had no tag
// (Facebook, X and Reddit each append their own). Returns null when there is
// nothing to go on, i.e. the visitor came in direct.
const NAMES = {
  facebook: 'Facebook', fb: 'Facebook', meta: 'Facebook', facebook_ads: 'Facebook', fb_ads: 'Facebook', meta_ads: 'Facebook',
  instagram: 'Instagram', ig: 'Instagram', instagram_ads: 'Instagram', ig_ads: 'Instagram',
  x: 'X', twitter: 'X', x_ads: 'X', twitter_ads: 'X',
  drinkup: 'X profile link', join: 'X replies',
  fb_bio: 'Facebook profile link', ig_bio: 'Instagram profile link', drinkup_direct: 'the Drink Up link',
  reddit: 'Reddit', reddit_ads: 'Reddit',
  sms: 'SMS', email: 'Email', newsletter: 'Email',
  referral: 'a referral', batches: 'the bottle QR code',
  google: 'Google', tiktok: 'TikTok', youtube: 'YouTube',
};

export function signupSourceLabel({ utmSource, fbclid, twclid, rdtCid } = {}) {
  const raw = String(utmSource || '').trim();
  if (raw) {
    const known = NAMES[raw.toLowerCase()];
    if (known) return known;
    // An unrecognised tag: show it as written, minus anything odd, kept short.
    const clean = raw.replace(/[^\w .&+-]/g, '').trim().slice(0, 30);
    if (clean) return clean;
  }
  if (fbclid) return 'Facebook';
  if (twclid) return 'X';
  if (rdtCid) return 'Reddit';
  return null;
}

// Which profile a /drinkup visitor tapped through from, so ONE good-looking link
// can sit in the X, Facebook and Instagram bios and still be told apart. Read
// from the page that sent them (the Referer) and, failing that, the app's own
// in-app browser signature in the User-Agent. Returns the utm_source to tag:
//   'drinkup'        X (kept as-is, so history stays continuous)
//   'fb_bio'         Facebook
//   'ig_bio'         Instagram
//   'drinkup_direct' typed, spoken, or a browser that hid where it came from
// It never guesses: anything it can't place is 'drinkup_direct'.
export function bioDoor(referer, userAgent) {
  let host = '';
  try { host = new URL(String(referer || '')).hostname.toLowerCase(); } catch (e) {}
  const on = (d) => host === d || host.endsWith('.' + d);
  const ua = String(userAgent || '');
  if (on('instagram.com') || /\bInstagram\b/.test(ua)) return 'ig_bio';
  if (on('facebook.com') || on('fb.com') || on('fb.me') || /\bFBAN\/|\bFBAV\/|\bFB_IAB\b/.test(ua)) return 'fb_bio';
  if (on('t.co') || on('x.com') || on('twitter.com') || /\bTwitter(?:Android| for i)/.test(ua)) return 'drinkup';
  return 'drinkup_direct';
}

// "📣 New signup from Facebook" / "📣 New signup (direct)".
export function signupPushTitle(attribution) {
  const from = signupSourceLabel(attribution);
  return from ? `📣 New signup from ${from}` : '📣 New signup (direct)';
}
