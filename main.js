// Wilhelm Cold Brew — "The Crossing" interactions
// Ported from the design prototype's React component to dependency-free JS.

const PRICE = 28;

// ───────── Hero waves (matches the prototype's generated SVG paths) ─────────
(function renderWaves() {
  const svg = document.querySelector('.hero-waves');
  if (!svg) return;
  const ns = 'http://www.w3.org/2000/svg';
  let d = '';
  for (let i = 0; i < 40; i++) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute(
      'd',
      `M 0 ${100 + i * 20} Q 320 ${80 + i * 20 + Math.sin(i) * 15} 640 ${100 + i * 20} T 1280 ${100 + i * 20}`
    );
    path.setAttribute('stroke', 'var(--gold)');
    path.setAttribute('stroke-width', '0.5');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
  }
})();

// ───────── Buy: quantity stepper + live total ─────────
(function quantityStepper() {
  const valueEl = document.querySelector('[data-qty="value"]');
  const totalEl = document.querySelector('[data-total]');
  if (!valueEl) return;
  let qty = 1;

  const render = () => {
    valueEl.textContent = qty;
    if (totalEl) totalEl.textContent = `$${PRICE * qty}`;
  };

  document.querySelector('[data-qty="dec"]').addEventListener('click', () => {
    qty = Math.max(1, qty - 1);
    render();
  });
  document.querySelector('[data-qty="inc"]').addEventListener('click', () => {
    qty = Math.min(12, qty + 1);
    render();
  });
  render();
})();

// ───────── Mobile buy bar — slides in once the hero CTA scrolls out of view ─────────
(function mobileBuyBar() {
  const bar = document.getElementById('buybar');
  const heroActions = document.querySelector('.hero-actions');
  if (!bar || !heroActions || !('IntersectionObserver' in window)) return;

  const io = new IntersectionObserver(
    ([entry]) => bar.classList.toggle('show', !entry.isIntersecting),
    { rootMargin: '-80px 0px 0px 0px' }
  );
  io.observe(heroActions);
})();

// ───────── Mobile nav toggle ─────────
(function mobileNav() {
  const burger = document.querySelector('.nav-burger');
  const links = document.getElementById('nav-links');
  if (!burger || !links) return;

  const setOpen = (open) => {
    links.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', String(open));
  };

  burger.addEventListener('click', () => {
    setOpen(!links.classList.contains('open'));
  });
  // Close after tapping a link.
  links.querySelectorAll('a').forEach((a) =>
    a.addEventListener('click', () => setOpen(false))
  );
})();
