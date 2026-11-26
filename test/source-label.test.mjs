// The owner push title names where a signup came from.
//   node test/source-label.test.mjs
import { signupSourceLabel, signupPushTitle, bioDoor } from '../server/source-label.js';
let pass = 0, fail = 0;
const eq = (n, got, want) => { if (got === want) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };

console.log('\nTagged links');
eq('facebook', signupSourceLabel({ utmSource: 'facebook' }), 'Facebook');
eq('FB / meta spellings fold to Facebook', [ 'FB', 'meta', 'facebook_ads' ].map((u) => signupSourceLabel({ utmSource: u })).join(), 'Facebook,Facebook,Facebook');
eq('instagram', signupSourceLabel({ utmSource: 'ig' }), 'Instagram');
eq('x', signupSourceLabel({ utmSource: 'x' }), 'X');
eq('twitter → X', signupSourceLabel({ utmSource: 'Twitter' }), 'X');
eq('reddit', signupSourceLabel({ utmSource: 'reddit' }), 'Reddit');
eq('profile link', signupSourceLabel({ utmSource: 'drinkup' }), 'X profile link');
eq('facebook profile link (/fb)', signupSourceLabel({ utmSource: 'fb_bio' }), 'Facebook profile link');
eq('instagram profile link (/ig)', signupSourceLabel({ utmSource: 'ig_bio' }), 'Instagram profile link');
eq('referral', signupSourceLabel({ utmSource: 'referral' }), 'a referral');
eq('unknown tag shown as written', signupSourceLabel({ utmSource: 'podcast-ad' }), 'podcast-ad');
eq('odd characters stripped, kept short', signupSourceLabel({ utmSource: '<b>news</b>' + 'x'.repeat(60) }).length <= 30, true);

console.log('\nUntagged links fall back to the ad click id');
eq('fbclid only → Facebook', signupSourceLabel({ fbclid: 'abc' }), 'Facebook');
eq('twclid only → X', signupSourceLabel({ twclid: 'abc' }), 'X');
eq('rdt_cid only → Reddit', signupSourceLabel({ rdtCid: 'abc' }), 'Reddit');
eq('the tag wins over a click id', signupSourceLabel({ utmSource: 'x', fbclid: 'abc' }), 'X');
eq('nothing → null', signupSourceLabel({}), null);

console.log('\nOne /drinkup link, three profiles: which one was tapped');
const IG_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.20.111 (iPhone14,2; iOS 17_5; en_US; en; scale=3.00; 1170x2532; 600000000)';
const FB_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/460.0.0.30.109;FBBV/600000000;FBDV/iPhone14,2;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]';
const X_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.40';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
eq('instagram link shim referrer', bioDoor('https://l.instagram.com/', SAFARI), 'ig_bio');
eq('instagram app, no referrer', bioDoor('', IG_UA), 'ig_bio');
eq('facebook link shim referrer', bioDoor('https://l.facebook.com/l.php?u=x', SAFARI), 'fb_bio');
eq('facebook mobile site referrer', bioDoor('https://m.facebook.com/wilhelm', SAFARI), 'fb_bio');
eq('facebook app, no referrer', bioDoor(undefined, FB_UA), 'fb_bio');
eq('x link shim referrer', bioDoor('https://t.co/abc123', SAFARI), 'drinkup');
eq('x app, no referrer', bioDoor('', X_UA), 'drinkup');
eq('typed / no clue → not guessed', bioDoor('', SAFARI), 'drinkup_direct');
eq('some other site → not guessed', bioDoor('https://www.google.com/', SAFARI), 'drinkup_direct');
eq('look-alike host is not Facebook', bioDoor('https://notfacebook.com/', SAFARI), 'drinkup_direct');
eq('garbage referrer is safe', bioDoor('not a url', SAFARI), 'drinkup_direct');
eq('label for the unknown door', signupSourceLabel({ utmSource: 'drinkup_direct' }), 'the Drink Up link');

console.log('\nPush title');
eq('from Facebook', signupPushTitle({ utmSource: 'facebook' }), '📣 New signup from Facebook');
eq('from X', signupPushTitle({ twclid: '2-abc' }), '📣 New signup from X');
eq('direct', signupPushTitle({ utmSource: null }), '📣 New signup (direct)');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
