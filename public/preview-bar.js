// Admin batch preview — the strip across the top of a storefront page opened
// with ?preview=1&drop=<id>. Loaded on demand by buy.js / soldout.js only in
// preview mode, so normal visitors never download it. It names the batch being
// previewed, links the three views, and makes it obvious the page isn't live.
window.wilhelmPreviewBar = function (info) {
  info = info || {};
  var old = document.getElementById('wcb-preview-bar');
  if (old) old.parentNode.removeChild(old);

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var id = encodeURIComponent(info.drop || '');
  var views = [
    ['buy', 'Buy page', '/buy/?preview=1&drop=' + id],
    ['countdown', 'Countdown', '/buy/?preview=1&drop=' + id + '&view=countdown'],
    ['soldout', 'Sold out', '/sold-out/?preview=1&drop=' + id],
  ];

  var bar = document.createElement('div');
  bar.id = 'wcb-preview-bar';
  bar.setAttribute('style', [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483000',
    'background:#e8c24a', 'color:#0c0a08', 'font:600 12px/1.35 "DM Mono",ui-monospace,Menlo,monospace',
    'letter-spacing:.4px', 'padding:calc(7px + env(safe-area-inset-top,0px)) 40px 7px 12px',
    'display:flex', 'flex-wrap:wrap', 'gap:4px 14px', 'align-items:center', 'justify-content:center',
    'box-shadow:0 2px 10px rgba(0,0,0,.35)', 'text-align:center',
  ].join(';'));

  var html;
  if (info.error === 'login') {
    html = '<span>PREVIEW — sign in to the admin on this device to see it.</span>' +
           '<a href="/admin/" style="color:#0c0a08;text-decoration:underline">Open admin</a>';
  } else if (info.error) {
    html = '<span>PREVIEW — that batch could not be loaded.</span>' +
           '<a href="/admin/" style="color:#0c0a08;text-decoration:underline">Back to admin</a>';
  } else {
    var live = info.status === 'live';
    html = '<span>PREVIEW · ' + esc(info.name || 'Batch') + ' · ' +
           (live ? 'this batch is LIVE' : esc(info.status || 'draft') + ', not visible to customers') +
           ' · checkout disabled</span><span>' +
           views.map(function (v) {
             var on = v[0] === info.view;
             return '<a href="' + v[2] + '" style="color:#0c0a08;margin:0 5px;padding:2px 7px;border-radius:4px;text-decoration:none;' +
                    (on ? 'background:#0c0a08;color:#e8c24a' : 'border:1px solid rgba(12,10,8,.45)') + '">' + v[1] + '</a>';
           }).join('') + '</span>';
  }
  bar.innerHTML = html +
    '<button type="button" aria-label="Hide preview bar" style="position:absolute;right:6px;top:calc(3px + env(safe-area-inset-top,0px));' +
    'background:none;border:0;font:700 18px/1 sans-serif;color:#0c0a08;cursor:pointer;padding:4px 8px">×</button>';
  document.body.appendChild(bar);

  // Push the page down by the bar's height so nothing hides underneath it.
  var prevPad = document.body.style.paddingTop;
  function fit() { document.body.style.paddingTop = bar.offsetHeight + 'px'; }
  fit();
  window.addEventListener('resize', fit);
  bar.querySelector('button').addEventListener('click', function () {
    window.removeEventListener('resize', fit);
    document.body.style.paddingTop = prevPad;
    bar.parentNode.removeChild(bar);
  });
};
