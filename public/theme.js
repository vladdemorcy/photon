// Theme switcher: Match this device, Light or Dark. The choice is remembered in this
// browser only, so each device can have its own.
(function () {
  const root = document.documentElement;
  const media = window.matchMedia ? matchMedia('(prefers-color-scheme: light)') : null;
  const meta = document.querySelector('meta[name="theme-color"]');

  function read() { try { return localStorage.getItem('photon.theme') || 'system'; } catch { return 'system'; } }
  function apply(pref) {
    const dark = pref === 'dark' || (pref === 'system' && !(media && media.matches));
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.themePref = pref;
    if (meta) meta.content = dark ? '#04060d' : '#eef1f8';
    document.querySelectorAll('[data-theme-choice]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === pref)));
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-theme-choice]');
    if (!b) return;
    try { localStorage.setItem('photon.theme', b.dataset.themeChoice); } catch { /* storage blocked: still switch for now */ }
    apply(b.dataset.themeChoice);
  });
  // Follow the device when set to match it.
  if (media) media.addEventListener('change', () => { if (read() === 'system') apply('system'); });
  apply(read());
})();
