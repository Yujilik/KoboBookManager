import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, RefreshCw } from 'lucide-react';
import { isAndroid } from './native';
import { useI18n } from './i18n';
import { APP_VERSION, fetchUpdate, updater, type AppUpdate } from './updates';
import type { MessageKey } from './messages';

export function useAppUpdates() {
  const [current, setCurrent] = useState(APP_VERSION);
  const [available, setAvailable] = useState<AppUpdate>();
  const [status, setStatus] = useState<MessageKey>();
  const [working, setWorking] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const locked = useRef(false);

  const check = async () => {
    if (locked.current) return;
    locked.current = true; setWorking(true);
    setStatus('checkingUpdates');
    try {
      const next = await fetchUpdate(current);
      if (next?.url !== available?.url) setDownloaded(false);
      setAvailable(next);
      setStatus(next ? undefined : 'appUpToDate');
    } catch (error) {
      setStatus(error instanceof Error && error.message === 'noRelease' ? 'noRelease' : 'updateCheckFailed');
    } finally { locked.current = false; setWorking(false); }
  };
  useEffect(() => {
    if (!isAndroid) return;
    let alive = true;
    void updater.getVersion().then(({ version }) => {
      if (!alive) return;
      setCurrent(version);
    }).catch(() => { /* Manual checks remain available. */ });
    return () => { alive = false; };
  }, []);

  const install = async () => {
    if (!available || locked.current || !isAndroid) return;
    locked.current = true; setWorking(true);
    try {
      if (!downloaded) {
        setStatus('downloadingUpdate');
        await updater.download(available);
        setDownloaded(true);
      }
      setStatus('confirmUpdateInstall');
      await updater.install();
    } catch (error) {
      const message = String((error as { message?: unknown })?.message ?? error);
      if (!message.includes('installPermissionDenied')) setDownloaded(false);
      setStatus(message.includes('installPermissionDenied') ? 'installPermissionHint' : 'updateInstallFailed');
    } finally { locked.current = false; setWorking(false); }
  };
  return { current, available, status, working, downloaded, check, install };
}

export function AppUpdates({ updates, disabled }: { updates: ReturnType<typeof useAppUpdates>; disabled: boolean }) {
  const { t } = useI18n();
  return <div className="settings-section app-updates"><h3>{t('appUpdates')}</h3><p>{t('installedVersion', { version: updates.current })}</p>
    <p className="hint">{t('updatesPrivacy')}</p>
    {updates.available && <p role="status">{t('newVersion', { version: updates.available.version })}</p>}
    {updates.status && <p role="status">{t(updates.status)}</p>}
    {!isAndroid && <p className="hint">{t('updateAndroidOnly')}</p>}
    <div className="button-row"><button className="secondary" disabled={disabled || updates.working} onClick={() => void updates.check()}><RefreshCw size={17} className={updates.working ? 'spin' : ''}/>{t('checkUpdates')}</button>
      {updates.available && <button className="primary" disabled={disabled || updates.working || !isAndroid} onClick={() => void updates.install()}><ArrowDownToLine size={17}/>{t(updates.downloaded ? 'installUpdate' : 'downloadUpdate')}</button>}
    </div>
  </div>;
}
