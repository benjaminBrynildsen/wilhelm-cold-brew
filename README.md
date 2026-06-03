# Wilhelm Cold Brew

E-commerce landing page for **Wilhelm** — a bourbon-barrel-aged, non-alcoholic luxury cold brew. Design direction: *"The Crossing"* — matte black & gold, Bodoni/Lora/DM Mono, telling the story of Wilhelm the glove maker's 1897 crossing from Bergen, Norway to Brooklyn.

Static site — no build step.

## Structure

- `index.html` — the full single-page site (nav, hero, story, tasting notes, buy, footer)
- `styles.css` — all styling; theme is **antique gold + espresso** baked into `:root`
- `main.js` — hero waves, quantity stepper, mobile buy bar, mobile nav
- `assets/` — hero product photo, Wilhelm figure portrait, wordmark

## Local dev

```bash
python3 -m http.server 5050
# → http://localhost:5050
```

## Deploy

Hosted on Render as a static site (`render.yaml`). Pushes to `main` auto-deploy.

## TODO

- Wire the cart / express-checkout buttons to Shopify or Stripe
- Real Instagram / contact links in the footer
