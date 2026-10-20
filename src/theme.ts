/** One system preference drives both the palette and browser chrome. */
export function followSystemTheme() {
  const preference = window.matchMedia('(prefers-color-scheme: dark)');
  // Preview helpers are eliminated from production builds. They also let us
  // inspect edge-to-edge layout without an Android device connected.
  const preview = import.meta.env.DEV ? new URLSearchParams(window.location.search) : undefined;
  const forced = preview?.get('previewTheme');
  const update = () => {
    const dark = forced === 'dark' || (forced !== 'light' && preference.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#2d353b' : '#f8f7f3');
  };
  if (preview?.has('previewInsets')) {
    document.documentElement.style.setProperty('--safe-area-inset-top', '32px');
    document.documentElement.style.setProperty('--safe-area-inset-bottom', '24px');
  }
  update();
  preference.addEventListener('change', update);
  const stop = () => preference.removeEventListener('change', update);
  if (import.meta.hot) import.meta.hot.dispose(stop);
  return stop;
}
