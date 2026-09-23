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

American bourbon must, by federal regulation, be stored in **charred new oak barrels**, and entered into them at no more than 125° proof.[^3] A given barrel therefore serves a single bourbon fill, after which the distillery is left holding an expensive piece of cooperage it is forbidden to use again for that purpose. The secondary market this creates is the reason used bourbon barrels find their way to scotch producers, to brewers, and to operations such as ours.

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

Ethanol boils at 78.37 °C at atmospheric pressure.[^5] First crack — the audible moment that marks the beginning of a light roast — arrives at a bean temperature near 196 °C, and specialty roasters commonly drop the batch somewhere between 212 and 218 °C.[^6] Even the lightest roast therefore holds the bean far above ethanol's boiling point, for minutes.

No meaningful quantity of ethanol survives that. It volatilizes early, long before first crack, and departs with the exhaust.

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
  'Mosedale, J. R. & Puech, J.-L. *Wood maturation of distilled beverages.* Trends in Food Science & Technology 9(3), 95–101 (1998).',
  'Conner, J. M., Paterson, A. & Piggott, J. R. *Changes in wood extractives from oak cask staves through maturation of Scotch malt whisky.* Journal of the Science of Food and Agriculture 62(2), 169–174 (1993).',
  '27 CFR § 5.143(c), Table 1 — Standards of Identity for Distilled Spirits. Bourbon whisky must be distilled at 160° proof or less and stored in charred new oak barrels at 125° proof or less. (Formerly § 5.22; renumbered in the TTB labeling modernization.)',
  'FDA Compliance Policy Guide Sec. 510.400 — beverages containing less than 0.5% alcohol by volume are considered non-alcoholic. Compare 27 CFR § 7.65, the parallel labeling rule for malt beverages, and the Alcoholic Beverage Labeling Act of 1988, which requires a health warning at 0.5% ABV and above.',
  'Ethanol, normal boiling point 78.37 °C at 1 atm.',
  'Coffee roasting: first crack occurs at a bean temperature near 196 °C; specialty roasters commonly drop between 212 and 218 °C.',
].join('\n');

// Second piece. Seeded as a DRAFT — Matt reviews and publishes it from the
// admin rather than it going live the moment the table is created.
const COFERM_BODY = `:::fact
Two different practices share the name. **Microbial co-fermentation** — inoculating the fermenting coffee cherry with selected yeast or lactic acid bacteria — is supported by a real and growing body of peer-reviewed work. **Additive fermentation**, sometimes called infusion, puts fruit, spices or syrups into the tank, and is a question about flavoring and disclosure rather than about fermentation. Most of the public argument comes from treating them as one thing.
:::

## The word is doing too much work

Ask three people in specialty coffee what co-fermentation means and you may get three answers, which is a poor foundation for an argument as heated as this one has become.

In its narrow and older sense, co-fermentation describes inoculating the fermenting coffee fruit with chosen microorganisms — commonly *Saccharomyces cerevisiae*, the yeast of bread and beer, or lactic acid bacteria such as *Lactiplantibacillus plantarum* — rather than leaving the process to whatever happens to be living on the cherry and in the tank. Nothing enters that could not plausibly have arrived on its own. What changes is which organisms dominate, and how predictably.

In its broader and more recent sense, the same word covers the addition of material that is not a microorganism at all: fruit pulp, cinnamon, tropical juices, occasionally proprietary flavor compounds. The industry has begun to separate this as *additive fermentation* or *infusion*, and the distinction is worth insisting upon, because the two practices differ in mechanism, in what can be claimed for them, and in what a buyer is entitled to be told.

We will take them in turn, because the evidence is very different in each case.

## What the research actually supports

The literature on inoculated fermentation is genuine, peer-reviewed, and has grown quickly over the past five years.

A 2024 study in *Food Chemistry* fermented coffee fruit with sequential inoculation — *L. plantarum* first, then *S. cerevisiae* — across 48- and 96-hour fermentations, and identified forty-seven volatile compounds in the resulting coffee, with furfuryl acetate, pyridine and 1-methylpyrrole predominating.[^1] The sensory outcome was a shift toward fruity and fermented notes, and greater aromatic complexity relative to spontaneous controls.

Earlier co-inoculation work has gone further, identifying 108 volatile compounds across seventeen chemical classes in green and roasted samples, among them 2,3-butanediol, a product of lactic acid bacterial metabolism that contributes to aroma.[^2] Related studies have found that selected yeasts and lactic acid bacteria tolerate the stresses of postharvest processing, consume the sugars of the fruit pulp efficiently, and generate organic acids and volatile precursors reliably enough to be used deliberately.[^3]

The conclusion those papers support is a modest and useful one: **controlled microbial fermentation measurably changes the volatile composition of the resulting coffee, and it does so more consistently than spontaneous fermentation.** That is a real finding. It is also a narrower claim than the marketing usually makes.

> The organisms do not deposit flavor. They metabolize sugar, and the roast makes something of what they leave behind.

## Why the mechanism limits what can be claimed

It is tempting to imagine inoculation as a way of writing a flavor into the bean. The chemistry does not work like that, and understanding why is the best defense against the more extravagant claims.

The microorganisms act on the mucilage — the sugary layer surrounding the seed — not on the seed itself. They consume its sugars and produce organic acids, alcohols and other small molecules. Some of those diffuse into the bean; others alter the pH and the rate at which the fermentation proceeds, which in turn affects what else can grow. The bean that emerges is chemically different, but what it carries is mostly *precursors*, not finished aromas.

Roasting then takes those precursors and does its own work on them, through the Maillard reaction and the degradation of sugars and acids. The aroma in the cup is the product of that second transformation, not a survival of the first.

Every step in that chain is sensitive to conditions. Which is why a result obtained with one cultivar, at one altitude, in one season, with one roast profile, is evidence that something is possible — not a recipe that transfers.

## Where the claims outrun the evidence

Several things are asserted confidently in the trade that the published work does not currently support.

- **That a specific flavor can be selected in advance.** The studies report directions — fruitier, more complex, more acidic — not targets hit on demand.
- **That effects are large.** Reported differences are usually real but moderate, and frequently smaller than the difference between two roast profiles of the same lot.
- **That the microbe is responsible for the whole difference.** Inoculation nearly always accompanies changes in tank management, timing and temperature, and few published designs isolate the organism's contribution from the processing change around it.
- **That results generalize across origins.** Most studies are single-origin, single-season, and modest in sample size.

None of this makes inoculated fermentation illegitimate. It makes it a technique with a real but bounded effect, which is a less thrilling description than the one usually offered.

## Infusion is a different question

When fruit, spice or a flavor compound goes into the tank, fermentation is no longer doing the work that the name implies. The material is a flavoring, and the honest questions become commercial rather than chemical: was the buyer told, and does the label reflect it?

The industry has not settled on one answer, and the competition rules diverge sharply.

| Body | Position |
| --- | --- |
| Alliance for Coffee Excellence (Cup of Excellence) | Revised eligibility in 2023 to exclude non-microbial additives — fruits, spices and similar — from competition lots |
| Best of Panama | Excluded infused coffees from the 2024 competition, citing the authenticity of the country's coffee identity |
| Specialty Coffee Association (World Barista Championship) | Permitted infused and co-fermented coffees from late 2023, provided additions occur before the green coffee stage |
^ Positions taken by major competition bodies as reported in the trade press, 2023–2024.[^4]

Reasonable people land in different places on whether infusion is an innovation or an adulteration. Our own view is narrower and, we think, harder to argue with: whatever went into the tank should be on the bag. A drinker who knows what they are buying can decide for themselves, and a producer confident in the method should have no reason to be vague about it.

## How to read a co-fermentation claim

A few questions separate a substantive claim from a decorative one.

- **Did anything non-microbial enter the tank?** This is the first and most important question, and it is usually answerable in one sentence.
- **Is the organism named?** "Co-fermented with *L. plantarum*" is a claim. "Co-fermented" alone is a category.
- **What was it compared against?** A difference is only meaningful relative to a control — the same lot, spontaneously fermented.
- **How precise is the number?** Specific figures for compound migration, offered without a citation, are the clearest signal that the science is being borrowed rather than done.

## Where the evidence runs out

The honest summary is that this field is young.

Sample sizes are small, sensory panels are smaller, and the literature carries the publication bias one would expect of a commercially interesting technique — negative results are not much published. Few studies follow the same lot across multiple seasons, which is where the variability that matters commercially actually lives.

And one gap is conspicuous from where we stand: almost nothing published examines how co-fermented lots behave under **cold** extraction. Cold brew pulls a different compound set than hot water does, at a different rate, and there is no good reason to assume that a fermentation difference measured in an espresso or filter cup survives into a twenty-hour cold extraction at the same magnitude, or at all. We would like to know. As far as we can tell, nobody has published it.`;

const COFERM_REFS = [
  'Rabelo, M. H. S., Borém, F. M., Alves, A. P. de C., Pieroni, R. S., Santos, C. M., Nakajima, M. & Sugino, R. *Fermentation of coffee fruit with sequential inoculation of Lactiplantibacillus plantarum and Saccharomyces cerevisiae: Effects on volatile composition and sensory characteristics.* Food Chemistry 444, 138608 (2024). doi:10.1016/j.foodchem.2024.138608',
  'Co-inoculation studies identifying 108 volatile compounds across 17 chemical classes in green and roasted coffee, including 2,3-butanediol of lactic-acid-bacterial origin — see the co-inoculation literature in International Journal of Food Microbiology and European Food Research and Technology, 2022–2024.',
  '*Increasing the quality and complexity of pulped coffee fermentation with Lactiplantibacillus plantarum and selected yeasts.* European Food Research and Technology (2024). doi:10.1007/s00217-024-04640-7',
  'Competition positions as reported in the specialty trade press, 2023–2024: Alliance for Coffee Excellence eligibility revisions (2023), Best of Panama (2024), and Specialty Coffee Association World Barista Championship rules (late 2023). Verify current rules directly with each body before relying on them.',
].join('\n');

// ── Drop article: the Willett barrel ────────────────────────────────────────
// The piece the Wednesday email links to. Written to earn the phrase "the full
// walkthrough" — the email makes the claims, this shows the work behind them.
const WILLETT_BODY = `:::fact
This batch was aged in a barrel that previously held Willett whiskey — a family distillery in Bardstown, Kentucky, distilling since 1936 on land the family has farmed since 1792. Bourbon enters the barrel at no more than 125 proof and sits in it for years. When it is emptied, the wood is still holding a great deal of what it took in. Our green coffee goes in next.
:::

## Whose barrel this is

Willett is not a large operation, and that is much of the point of it.

The family has been in Nelson County since 1792, when William Willett moved down from Maryland. The distillery itself was built in 1936 — three years after Prohibition ended — on the family's own hog farm at one of the highest points in the county, and the first barrel was rolled into Warehouse A on St Patrick's Day, 1937. It remains independent and family-run, on roughly 130 acres, with Willetts still working the property. They run six mash bills, four bourbon and two rye.

Ours is a bourbon barrel.

We are not claiming any association with the distillery, and they have no involvement in what we make. We bought a barrel that held their whiskey, which is what the secondary market for used cooperage exists to do. But whose barrel it was matters to the coffee, and it is worth being specific rather than saying "bourbon barrel" and leaving it there.

## Why an emptied barrel is not empty

Federal law requires bourbon to be matured in charred new oak barrels, and to enter them at no more than 125 proof.[^1] One fill, one bourbon, and then the distillery owns a barrel it can never legally use for bourbon again. That rule is the reason a barrel like this one is available to us at all.

What arrives is not a dry container. Oak is porous, and across years of maturation the spirit works its way into the staves — distillers and coopers commonly put it at several gallons still held in the wood of a standard 53-gallon barrel after it has been drained. Seasonal expansion and contraction drive liquid into the wood and back out again, over and over, for the whole life of the fill. By the time the whiskey leaves, the barrel has been thoroughly worked.

> The whiskey spent years teaching that wood what to taste like. We are the next thing to ask it.

## What the wood actually has to give

The flavors that come out of a barrel are not whiskey. They are oak, and they are the products of what heat did to the oak when it was toasted and charred before it ever held spirit.

| Compound | What it contributes |
| --- | --- |
| **Oak lactones** | Coconut, woody sweetness |
| **Vanillin** | Vanilla — lignin broken down by the heat of toasting |
| **Furfural, 5-methylfurfural** | Caramel, almond, toasted grain |
| **Eugenol, guaiacol** | Clove, spice, a trace of smoke |
| **Ellagitannins** | Structure and grip through the middle |
^ The compounds a used bourbon barrel carries, and what each one does in the cup.

There is residual spirit character in the wood as well, and it contributes. But the list above is where most of what you will taste comes from, and none of it is alcohol. We have written the chemistry of that at length in [a separate piece](/journal/barrel-aged-coffee-alcohol/), including why the roast settles the alcohol question before the coffee is ever brewed.

## Why the coffee goes in green

Green coffee is dense, dry and porous. It has not yet been through the roast that will transform it, and in that state it takes up what it sits beside.

That porosity is the whole reason the method works. A finished cold brew put into a barrel would pick up some character, but green coffee has weeks to take on the oak slowly, and then a roast afterwards to turn what it absorbed into something else entirely. The barrel does not deposit a finished flavor. It leaves material, and the roast makes something of it.

It also means the timing is not negotiable. The barrel's work has to be finished before the roast begins, because the roast is what fixes it.

## What it tastes like

Dark caramel. Vanilla. Baking spice. A rounded sweetness through the middle that straight cold brew does not usually have, and a longer finish than the same coffee gives without the barrel.

The thing we would most want you to know is that it still tastes like coffee. This is not a whiskey-flavored drink, and it is not sweetened. The origin character is still there underneath — the barrel sits around it rather than over it.

## How we would drink it

Neat, cold, in a short glass. Over one large cube if the room is warm.

A small splash of cream does something worth trying: the oak and vanilla push forward and the whole thing turns dessert-adjacent without any sugar being involved. Several of the people who have written to us about previous barrel batches drink it that way.

It is 750ml and it is not sweetened, so it will also do perfectly well as the base of something else. We would just suggest tasting it on its own first.`;

const WILLETT_REFS = [
  '27 CFR § 5.143(c), Table 1 — Standards of Identity for Distilled Spirits. Bourbon whisky must be distilled at 160° proof or less and stored in charred new oak barrels at 125° proof or less.',
  'Willett Distillery, Bardstown, Kentucky — founded 1936; first barrel warehoused March 1937; family in Nelson County since 1792; six mash bills. Company and public sources.',
  'Mosedale, J. R. & Puech, J.-L. *Wood maturation of distilled beverages.* Trends in Food Science & Technology 9(3), 95–101 (1998).',
].join('\n');

// The roadmap shown under "In the works" on the index. These are drafts with a
// summary and no body — visible as a plan, not readable until written.
const QUEUED = [
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

    // Seeded as a draft: Matt reviews it and publishes it himself from the admin.
    await q(`INSERT INTO journal_articles
               (slug, title, category, summary, dek, body, refs, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'draft')`,
      ['barrel-aged-coffee-alcohol',
       'Does barrel-aged coffee contain alcohol?',
       'Barrel Aging',
       'An account of what a bourbon barrel actually contributes to coffee, why the roast resolves the alcohol question before the coffee is ever brewed, and where the published evidence runs out.',
       'It is the question we are asked more than any other, and it deserves a fuller answer than the reassurance usually offered in its place. For coffee aged the way ours is, the answer is no — not as a matter of assurance, but as a consequence of the temperatures involved.',
       BODY, REFS]);

    // Seeded as a draft: Matt reads it and publishes it himself.
    await q(`INSERT INTO journal_articles
               (slug, title, category, summary, dek, body, refs, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'draft')`,
      ['coffee-co-fermentation-what-the-research-says',
       'Co-fermentation: what the research actually says',
       'Co-fermentation',
       'Two different practices share one name, which is where most of the argument comes from. What the peer-reviewed work supports, what it does not, and how to read a claim on a bag.',
       'Co-fermentation has become the most argued-about word in specialty coffee, and a good deal of the heat comes from a simple confusion: the term now covers two practices that differ in mechanism, in evidence, and in what a buyer is owed.',
       COFERM_BODY, COFERM_REFS]);

    // This week's drop article. On a fresh database with no drops yet (local
    // dev), create a sample drop so the linking is visible; on production the
    // drops table already has real rows, so nothing is invented and Matt links
    // the article to the real batch from the admin.
    let dropId = null;
    const anyDrops = await q(`SELECT COUNT(*)::int n FROM drops`);
    if (+anyDrops.rows[0].n === 0) {
      const friday = new Date();
      friday.setUTCDate(friday.getUTCDate() + ((5 - friday.getUTCDay() + 7) % 7 || 7));
      friday.setUTCHours(14, 0, 0, 0);   // 9:00 AM Central
      const d = await q(`INSERT INTO drops (name, price_cents, bottle_cap, opens_at, status,
                                            barrel, origin, varietal, elevation, roast, tasting_notes)
                         VALUES ($1,5000,100,$2,'scheduled',$3,$4,$5,$6,$7,$8) RETURNING id`,
        ['The Willett Barrel', friday,
         'Willett bourbon barrel', 'Single origin', 'Not set', 'Not set', 'Light',
         'Dark caramel, vanilla, baking spice, rounded sweetness.']);
      dropId = d.rows[0].id;
      console.log('[journal] created a sample drop for local dev');
    }

    await q(`INSERT INTO journal_articles
               (slug, title, category, summary, dek, body, refs, status, drop_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8)`,
      ['the-willett-barrel',
       'The Willett barrel',
       'This Week',
       "Whose barrel this is, why an emptied whiskey barrel is nowhere near empty, what the oak actually has to give, and why the coffee goes in green.",
       'This Friday\'s batch came out of a barrel that spent years holding Willett whiskey. Here is what that means for the coffee, and what the wood had left to give it.',
       WILLETT_BODY, WILLETT_REFS, dropId]);

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
