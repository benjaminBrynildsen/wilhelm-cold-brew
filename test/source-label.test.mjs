// The owner push title names where a signup came from.
//   node test/source-label.test.mjs
import { signupSourceLabel, signupPushTitle } from '../server/source-label.js';
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

console.log('\nPush title');
eq('from Facebook', signupPushTitle({ utmSource: 'facebook' }), '📣 New signup from Facebook');
eq('from X', signupPushTitle({ twclid: '2-abc' }), '📣 New signup from X');
eq('direct', signupPushTitle({ utmSource: null }), '📣 New signup (direct)');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
