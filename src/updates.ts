import { registerPlugin } from '@capacitor/core';
import { version } from '../package.json';

export const APP_VERSION = version;
export const RELEASE_API = 'https://api.github.com/repos/Yujilik/KoboBookManager/releases/latest';
const MAX_APK_SIZE = 128 * 1024 * 1024;

export interface AppUpdate { version: string; url: string; size: number; digest?: string }
export interface UpdateInstaller {
  getVersion(): Promise<{ version: string }>;
  download(options: AppUpdate): Promise<void>;
  install(): Promise<void>;
}
export const updater = registerPlugin<UpdateInstaller>('AppUpdates');

function numbers(value: string): number[] | undefined {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = numbers(candidate), installed = numbers(current);
  if (!next || !installed) return false;
  for (let i = 0; i < 3; i++) if (next[i] !== installed[i]) return next[i] > installed[i];
  return false;
}
export function selectUpdate(release: unknown, current: string): AppUpdate | undefined {
  if (!release || typeof release !== 'object') return;
  const data = release as Record<string, unknown>;
  if (data.draft !== false || data.prerelease !== false || typeof data.tag_name !== 'string' || !isNewerVersion(data.tag_name, current)) return;
  const version = data.tag_name.replace(/^v/, '');
  if (!Array.isArray(data.assets)) return;
  const name = `KoboBookManager-${version}.apk`;
  for (const entry of data.assets) {
    if (!entry || typeof entry !== 'object') continue;
    const asset = entry as Record<string, unknown>;
    if (asset.name !== name || asset.state !== 'uploaded' || typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_APK_SIZE) continue;
    const url = `https://github.com/Yujilik/KoboBookManager/releases/download/${data.tag_name}/${name}`;
    if (asset.browser_download_url !== url) continue;
    if (asset.digest != null && (typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest))) continue;
    return { version, url, size: asset.size, digest: asset.digest as string | undefined };
  }
}
export async function fetchUpdate(current: string, fetcher: typeof fetch = fetch): Promise<AppUpdate | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetcher(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' }, signal: controller.signal, credentials: 'omit', cache: 'no-store' });
    if (response.status === 404) throw new Error('noRelease');
    if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) throw new Error('updateRateLimited');
    if (!response.ok) throw new Error('updateCheckFailed');
    const release = await response.json();
    if (!release || typeof release.tag_name !== 'string' || !numbers(release.tag_name)) throw new Error('updateCheckFailed');
    const update = selectUpdate(release, current);
    if (isNewerVersion(release.tag_name, current) && !update) throw new Error('updateApkUnavailable');
    return update;
  } finally { clearTimeout(timeout); }
}
