// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppUpdates, useAppUpdates } from '../src/AppUpdates';
import { I18nProvider } from '../src/i18n';
import { updater } from '../src/updates';

vi.mock('../src/native', () => ({ isAndroid: true }));
vi.mock('../src/updates', async importOriginal => ({
  ...await importOriginal<typeof import('../src/updates')>(),
  updater: { getVersion: vi.fn(), download: vi.fn(), install: vi.fn() },
}));
let root: Root, container: HTMLDivElement;
const fetcher = vi.fn<typeof fetch>();
function Widget() { return createElement(AppUpdates, { updates: useAppUpdates(), disabled: false }); }
function data(version = '0.2.5') { return { tag_name: version, draft: false, prerelease: false, assets: [{ name: `KoboBookManager-${version}.apk`, state: 'uploaded', size: 7000000, browser_download_url: `https://github.com/Yujilik/KoboBookManager/releases/download/${version}/KoboBookManager-${version}.apk` }] }; }
const button = (text: string) => Array.from(container.querySelectorAll('button')).find(item => item.textContent === text)!;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('fetch', fetcher);
  vi.mocked(updater.getVersion).mockResolvedValue({ version: '0.2.4' });
  vi.mocked(updater.download).mockResolvedValue(); vi.mocked(updater.install).mockResolvedValue();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function mount() { await act(async () => root.render(createElement(I18nProvider, null, createElement(Widget)))); }

it('makes no automatic request and only checks when the user presses Check for updates', async () => {
  await mount(); expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValue(new Response(JSON.stringify(data('0.2.4'))));
  await act(async () => button('Check for updates').click());
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('You have the latest version.');
  expect(updater.download).not.toHaveBeenCalled();
});

it('downloads on request, opens Android installation and retries a denied permission without downloading again', async () => {
  await mount(); fetcher.mockResolvedValue(new Response(JSON.stringify(data())));
  await act(async () => button('Check for updates').click());
  expect(container.textContent).toContain('Version 0.2.5 is available.');
  expect(updater.download).not.toHaveBeenCalled();
  vi.mocked(updater.install).mockRejectedValueOnce(new Error('installPermissionDenied'));
  await act(async () => button('Download & install update').click());
  expect(updater.download).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Installation permission was not granted.');
  await act(async () => button('Install downloaded update').click());
  expect(updater.install).toHaveBeenCalledTimes(2);
  expect(updater.download).toHaveBeenCalledTimes(1);
});

it('shows connection failure and permits another manual check', async () => {
  await mount(); fetcher.mockRejectedValue(new Error('offline'));
  await act(async () => button('Check for updates').click());
  expect(container.textContent).toContain('Could not check for updates.');
  expect(container.textContent).not.toContain('You have the latest version.');
  expect(button('Check for updates').disabled).toBe(false);
});
