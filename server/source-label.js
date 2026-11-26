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
  fb_bio: 'Facebook profile link', ig_bio: 'Instagram profile link',
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

// "📣 New signup from Facebook" / "📣 New signup (direct)".
export function signupPushTitle(attribution) {
  const from = signupSourceLabel(attribution);
  return from ? `📣 New signup from ${from}` : '📣 New signup (direct)';
}
