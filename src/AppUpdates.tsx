import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { isAndroid } from './native';
import { useI18n } from './i18n';
import { APP_VERSION, fetchUpdate, updater, type AppUpdate } from './updates';
import type { MessageKey } from './messages';

export function useAppUpdates() {
  const [current, setCurrent] = useState(APP_VERSION);
  const [available, setAvailable] = useState<AppUpdate>();
  const [status, setStatus] = useState<MessageKey>();
  const [working, setWorking] = useState(false);
  const locked = useRef(false);

  const check = async () => {
    if (locked.current) return;
    locked.current = true; setWorking(true);
    setStatus('checkingUpdates');
    try {
      const next = await fetchUpdate(current);
      setAvailable(next);
      setStatus(next ? undefined : 'appUpToDate');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      setStatus(message === 'noRelease' || message === 'updateApkUnavailable' || message === 'updateRateLimited' ? message : 'updateCheckFailed');
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

  const openRelease = async () => {
    if (!available || locked.current) return;
    locked.current = true; setWorking(true);
    try {
      if (isAndroid) await updater.openRelease({ url: available.url });
      else window.open(available.url, '_blank', 'noopener,noreferrer');
      setStatus(undefined);
    } catch {
      setStatus('updateOpenFailed');
    } finally { locked.current = false; setWorking(false); }
  };
  return { current, available, status, working, check, openRelease };
}

export function AppUpdates({ updates, disabled }: { updates: ReturnType<typeof useAppUpdates>; disabled: boolean }) {
  const { t } = useI18n();
  return <div className="settings-section app-updates"><h3>{t('appUpdates')}</h3><p>{t('installedVersion', { version: updates.current })}</p>
    <p className="hint">{t('updatesPrivacy')}</p>
    {updates.available && <p role="status">{t('newVersion', { version: updates.available.version })}</p>}
    {updates.status && <p role="status">{t(updates.status)}</p>}
    <div className="button-row"><button className="secondary" disabled={disabled || updates.working} onClick={() => void updates.check()}><RefreshCw size={17} className={updates.working ? 'spin' : ''}/>{t('checkUpdates')}</button>
      {updates.available && <button className="primary" disabled={disabled || updates.working} onClick={() => void updates.openRelease()}><ExternalLink size={17}/>{t('openUpdateRelease')}</button>}
    </div>
  </div>;
}
