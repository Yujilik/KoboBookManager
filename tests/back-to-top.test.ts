// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackToTop } from '../src/BackToTop';
import { I18nProvider } from '../src/i18n';

let root: Root, container: HTMLDivElement;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('scrollY', 0);
  vi.stubGlobal('scrollTo', vi.fn());
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(BackToTop))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});
const button = () => container.querySelector('button')!;
async function scroll(top: number) {
  vi.stubGlobal('scrollY', top);
  await act(async () => window.dispatchEvent(new Event('scroll')));
}

it('appears on scrolling and starts fading only after two seconds without another scroll', async () => {
  expect(button().getAttribute('aria-hidden')).toBe('true');
  await scroll(200);
  expect(button().classList.contains('visible')).toBe(true);
  await act(async () => vi.advanceTimersByTime(1500));
  await scroll(400);
  await act(async () => vi.advanceTimersByTime(1999));
  expect(button().classList.contains('visible')).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(button().classList.contains('visible')).toBe(false);
  expect(button().tabIndex).toBe(-1);
  await scroll(500);
  expect(button().classList.contains('visible')).toBe(true);
});

it('jumps straight to the top on click and hides when scrolling back to the top', async () => {
  await scroll(1000);
  await act(async () => button().click());
  expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' });
  expect(button().getAttribute('aria-hidden')).toBe('true');
  await scroll(200);
  await scroll(0);
  expect(button().classList.contains('visible')).toBe(false);
});

it('clears the inactivity timer when leaving the library', async () => {
  await scroll(1000);
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => root.render(null));
  expect(vi.getTimerCount()).toBe(0);
  await scroll(1200);
  expect(vi.getTimerCount()).toBe(0);
});
