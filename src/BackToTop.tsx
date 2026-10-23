import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { useI18n } from './i18n';

export function BackToTop() {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timeout);
      setVisible(window.scrollY > 64);
      if (window.scrollY > 64) timeout = setTimeout(() => setVisible(false), 2000);
    };
    window.addEventListener('scroll', update, { passive: true });
    return () => { window.removeEventListener('scroll', update); clearTimeout(timeout); };
  }, []);

  return <button type="button" className={'back-to-top' + (visible ? ' visible' : '')} aria-label={t('backToTop')} title={t('backToTop')} aria-hidden={!visible} tabIndex={visible ? 0 : -1} onClick={() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    setVisible(false);
  }}><ArrowUp size={22} aria-hidden="true"/></button>;
}
