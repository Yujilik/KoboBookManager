// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { fetchUpdate, isNewerVersion, RELEASE_API, selectUpdate } from '../src/updates';

function release(tag = 'v0.2.5') {
  const name = `KoboBookManager-${tag.replace(/^v/, '')}.apk`;
  return { tag_name: tag, draft: false, prerelease: false, assets: [{ name, state: 'uploaded', size: 7000000, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: `https://github.com/Yujilik/KoboBookManager/releases/download/${tag}/${name}` }] };
}
describe('manual GitHub updates', () => {
  it('compares numeric release versions, ignoring equal, older and prerelease versions', () => {
    expect(isNewerVersion('v0.2.10', '0.2.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
    for (const version of ['0.2.4', '0.2.3', '0.1.99', 'v0.2.5-beta', 'latest', '0.02.5', '9999999999999999999999.0.0']) expect(isNewerVersion(version, '0.2.4')).toBe(false);
  });
  it('accepts both existing tag conventions and selects the versioned APK', () => {
    for (const tag of ['v0.2.5', '0.2.5']) expect(selectUpdate(release(tag), '0.2.4')).toMatchObject({ version: '0.2.5', size: 7000000 });
    expect(selectUpdate(release('0.2.4'), '0.2.4')).toBeUndefined();
    expect(selectUpdate({ ...release(), prerelease: true }, '0.2.4')).toBeUndefined();
    expect(selectUpdate({ ...release(), draft: true }, '0.2.4')).toBeUndefined();
  });
  it('rejects foreign download URLs, mismatched names, oversized files and malformed digests', () => {
    const valid = release();
    for (const patch of [
      { browser_download_url: 'https://example.com/update.apk' },
      { browser_download_url: valid.assets[0].browser_download_url.replace('Yujilik', 'someone') },
      { browser_download_url: valid.assets[0].browser_download_url.replace('https:', 'http:') },
      { name: 'KoboBookManager-0.2.6.apk' }, { size: 0 }, { size: 129 * 1024 * 1024 }, { digest: 'invalid' }, { state: 'new' },
    ]) expect(selectUpdate({ ...valid, assets: [{ ...valid.assets[0], ...patch }] }, '0.2.4')).toBeUndefined();
  });
  it('checks the public endpoint without credentials and distinguishes network failure from no update', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(release())));
    expect((await fetchUpdate('0.2.4', fetcher))?.version).toBe('0.2.5');
    expect(fetcher).toHaveBeenCalledWith(RELEASE_API, expect.objectContaining({ credentials: 'omit', signal: expect.any(AbortSignal) }));
    fetcher.mockResolvedValue(new Response('', { status: 404 }));
    await expect(fetchUpdate('0.2.4', fetcher)).rejects.toThrow('noRelease');
    fetcher.mockResolvedValue(new Response('', { status: 403 }));
    await expect(fetchUpdate('0.2.4', fetcher)).rejects.toThrow('updateCheckFailed');
    fetcher.mockResolvedValue(new Response(JSON.stringify({ ...release(), assets: [] })));
    await expect(fetchUpdate('0.2.4', fetcher)).rejects.toThrow('updateCheckFailed');
  });
});
