// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { followSystemTheme } from '../src/theme';

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  document.head.innerHTML = '';
});

it('follows theme changes while open, updates browser chrome, and removes its listener on disposal', () => {
  const preference = new EventTarget();
  let dark = false;
  Object.defineProperty(preference, 'matches', { get: () => dark });
  vi.stubGlobal('matchMedia', vi.fn(() => preference));
  document.head.innerHTML = '<meta name="theme-color" content="#f8f7f3">';
  const stop = followSystemTheme();
  expect(document.documentElement.dataset.theme).toBe('light');
  dark = true; preference.dispatchEvent(new Event('change'));
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#2d353b');
  dark = false; preference.dispatchEvent(new Event('change'));
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#f8f7f3');
  stop(); dark = true; preference.dispatchEvent(new Event('change'));
  expect(document.documentElement.dataset.theme).toBe('light');
});
