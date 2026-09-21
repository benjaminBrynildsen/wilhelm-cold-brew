// First-run seed for The Ledger.
//
// The barrel-aging piece was written as a static page before the journal moved
// into the database. This puts it in as an ordinary row so it can be edited
// from the admin like anything written afterwards — nothing about it is
// special once it is in.
//
// Runs once: if the table has any row at all, this does nothing. It never
// overwrites an edit.

import { q } from './db.js';

const BODY = `:::fact
Our beans enter the bourbon barrel **green**, raw and unroasted, and are roasted only after they come out, at bean temperatures exceeding **200 °C**. Ethanol boils at **78.37 °C**. Whatever the staves surrender to the bean is driven off during the roast, long before the coffee is brewed. What survives the process is the oak.
:::

## How ours is made

The distinction is worth setting out before anything else, because the answer depends entirely upon it.

Green coffee — raw, dense, and still some months from being drinkable — is loaded into an emptied bourbon barrel and left there for an interval measured in weeks, and for certain lots in months. Green beans are hygroscopic and porous, and across that period they take up what the wood has to offer them.

The duration is not a fixed quantity, and a producer who quotes one as though it were is describing a house preference rather than a rule. It varies with the coffee itself — variety, density, residual moisture — and with the barrel: how recently it was emptied, how much spirit the staves still hold, how heavily the interior was charred. It varies again with what the roaster intends to do afterwards, since a longer rest asks a different profile of the roast than a shorter one.

The beans are then removed and roasted. What follows is our cold brew process, which is slow and particular in ways that warrant an article of their own. The finished brew is bottled and pasteurized in the sealed container, a heat step that renders it microbiologically stable so that a bottle opened months from now resembles the one we filled.

The oak therefore acts upon the green bean alone. By the time there is cold brew at all, the barrel's contribution was made and concluded weeks earlier, and everything that follows is a matter of roast and extraction.

## Why there is anything in the barrel to begin with

American bourbon must, by federal regulation, be matured in *new* charred oak containers.[^3] A given barrel therefore serves a single bourbon fill, after which the distillery is left holding an expensive piece of cooperage it is forbidden to use again for that purpose. The secondary market this creates is the reason used bourbon barrels find their way to scotch producers, to brewers, and to operations such as ours.

A barrel that has been dumped is not, in any meaningful sense, empty. Oak is porous, and over years of maturation a substantial volume of spirit is absorbed into the staves; distillers and coopers commonly place the figure at several gallons retained in the wood of a standard 53-gallon barrel after draining. The vessel our coffee enters is, in the literal sense, still wet.

Ethanol is therefore present when the green coffee goes in. The question is what becomes of it thereafter.

## What the barrel actually contributes

Remarkably little of it is alcohol. The sensory characteristics associated with barrel maturation — vanilla, a coconut-inflected woodiness, a faint smoke, the caramel weight through the middle of the palate — originate in the oak itself, and in the chemistry that heat performed upon the oak during toasting and charring. These compounds have been characterized in considerable detail by researchers working on spirits maturation.[^1][^2]

| Compound | Origin in the wood | Sensory contribution |
| --- | --- | --- |
| **β-methyl-γ-octalactone** *(the oak lactones)* | Native to oak; liberated during seasoning and toasting | Coconut, woody, sweet |
| **Vanillin** | Thermal degradation of lignin during toasting | Vanilla |
| **Furfural, 5-methylfurfural** | Degradation of hemicellulose under heat | Caramel, almond, toasted grain |
| **Eugenol, guaiacol, syringol** | Lignin breakdown, concentrated in the char layer | Clove, spice, smoke |
| **Ellagitannins** | Oak tannins, extracted slowly over time | Structure, grip, mouthfeel |
^ The principal oak-derived compounds in barrel maturation, their origin in the wood, and their sensory contribution.

None of these is ethanol. Within a maturing spirit, ethanol functions principally as a solvent, and an efficient one, drawing these compounds out of the wood over the years of a fill. But the solvent and the flavor are separable in a way that is easy to overlook, and that separation is precisely what allows barrel character to reach a product containing no meaningful alcohol.

> The barrel does not lend you bourbon. It lends you oak, and the record of what heat did to it.

## Why the roast resolves the question

Ethanol boils at 78.37 °C at atmospheric pressure.[^5] A coffee roast carries the bean past 200 °C and holds it there for a matter of minutes.[^6] No meaningful quantity of ethanol survives that treatment: it volatilizes early in the roast, well before first crack, and departs with the exhaust.

What makes this useful rather than merely fortunate is that the aromatic compounds do not behave the same way. Vanillin, the oak lactones and the furanic aldehydes are substantially less volatile and considerably more thermally stable than ethanol, and they persist through the roast largely intact. The roast is, in effect, a selective process — it removes the alcohol and retains the oak — and that asymmetry is the reason barrel-aged coffee is able to exist as a non-alcoholic product at all.

### What pasteurization does, and does not, accomplish

Our bottles are pasteurized after filling. This is a food-safety measure: controlled heat inactivates spoilage organisms and allows the coffee to keep without recourse to preservatives.

It should not be mistaken for an alcohol step, and we would rather say so than allow the assumption to stand unexamined. Pasteurization takes place within a sealed container, where volatiles have nowhere to go; nothing evaporates out of a closed bottle. The removal of ethanol is accomplished by the roast, which is an open system with an exhaust. Pasteurization keeps the coffee safe and stable, and that is the entirety of its function.

## Where the 0.5% threshold comes from

In the United States, 0.5% alcohol by volume is the conventional threshold beneath which a beverage is treated as non-alcoholic.[^4] Two observations about it are worth making. The first is that it is not zero. The second is that trace ethanol at this order of magnitude is thoroughly unremarkable in food — ordinary fermentation introduces it into ripe fruit, into certain breads, into kombucha, without anyone regarding those products as alcoholic.

For coffee aged green and subsequently roasted, the threshold is in any case largely beside the point. The roast is not a process that brings a product in under a limit; it is one that removes the analyte being measured.

## Where the evidence runs out

The chemistry set out above rests on several decades of careful work on spirits maturation: the mechanisms by which oak surrenders its extractives, the compounds generated during toasting and charring, the kinetics of extraction over a long fill. That literature is substantial, and it has been replicated.

The literature on barrel-aged *coffee* specifically is not. It is sparse, recent, and largely outside peer review. A good deal of what circulates as established fact within specialty coffee has been borrowed from wine and spirits research — sometimes a defensible extrapolation, sometimes not. Where a figure is offered for how much vanillin migrates into a green bean over sixty days, the appropriate response is to ask where it was measured.

We would rather mark the boundary between established chemistry, reasonable inference, and our own observation from batch work. We intend to keep marking it, including in those cases where the honest account proves less flattering than the confident one.`;

const REFS = [
  'Mosedale, J. R. & Puech, J.-L. *Wood maturation of distilled beverages.* Trends in Food Science & Technology, 9(3), 95–101 (1998).',
  'Conner, J. M., Paterson, A. & Piggott, J. R. Work on the extraction of oak extractives into maturing spirits, Journal of the Science of Food and Agriculture.',
  '27 CFR § 5.22 — Standards of Identity for Distilled Spirits (bourbon must be stored in new charred oak containers).',
  'US Alcohol and Tobacco Tax and Trade Bureau / FDA labeling practice — the 0.5% ABV threshold for non-alcoholic beverages.',
  'Ethanol, boiling point 78.37 °C at 1 atm — standard physical constant.',
  'Typical specialty coffee roast profiles, bean temperature ~195–230 °C.',
].join('\n');

// The roadmap shown under "In the works" on the index. These are drafts with a
// summary and no body — visible as a plan, not readable until written.
const QUEUED = [
  ['Co-fermentation, honestly assessed', 'Co-fermentation',
   "What the published research supports, what it doesn't, and why most claims outrun the evidence."],
  ['The extraction temperature curve', 'Extraction',
   'What changes between 4 °C and 22 °C, and what that costs you in the cup.'],
  ['Water chemistry for cold brew', 'Water',
   'Why the same beans taste different in two cities.'],
  ['Oxidation and shelf life', 'Stability',
   'What actually degrades in a bottled cold brew, and how fast.'],
  ['Inside our barrel program', 'Barrel Aging',
   'Which barrels, how long, and what changes in the green bean while it sits.'],
  ['Why we pasteurize', 'Process',
   'What heat does to a finished cold brew, and what it protects you from.'],
];

export async function seedJournal() {
  try {
    const { rows } = await q(`SELECT COUNT(*)::int n FROM journal_articles`);
    if (rows[0].n > 0) return;

    await q(`INSERT INTO journal_articles
               (slug, title, category, summary, dek, body, refs, status, published_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'published', now())`,
      ['barrel-aged-coffee-alcohol',
       'Does barrel-aged coffee contain alcohol?',
       'Barrel Aging',
       'An account of what a bourbon barrel actually contributes to coffee, why the roast resolves the alcohol question before the coffee is ever brewed, and where the published evidence runs out.',
       'It is the question we are asked more than any other, and it deserves a fuller answer than the reassurance usually offered in its place. For coffee aged the way ours is, the answer is no — not as a matter of assurance, but as a consequence of the temperatures involved.',
       BODY, REFS]);

    for (const [title, category, summary] of QUEUED) {
      await q(`INSERT INTO journal_articles (slug, title, category, summary, body, status)
               VALUES ($1,$2,$3,$4,'','draft') ON CONFLICT (slug) DO NOTHING`,
        [title.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 70),
         title, category, summary]);
    }
    console.log('[journal] seeded the first article and the roadmap');
  } catch (e) {
    console.warn('[journal] seed skipped:', e.message);
  }
}
