import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDownToLine, ArrowRight, BookOpen, Check, CheckSquare, ChevronDown, FileArchive, FolderOpen, HardDrive, Layers, LayoutGrid, Library, LoaderCircle, Plus, RefreshCw, Search, Settings, Smartphone, X } from 'lucide-react';
import type { Book, Metadata } from './types';
import { emptyMetadata, MAX_BOOK_SIZE, readEpub } from './epub';
import * as store from './library';
import { dataURL, fromBase64, isAndroid, native, type Delivery, type Folder } from './native';
import { exportCollection, saveFile } from './export';
import { CollectionEditor } from './CollectionEditor';
import { I18nProvider, translatedError, useI18n } from './i18n';
import { locales, localeNames, type Locale } from './messages';
import { Modal } from './Modal';
import './style.css';
import './collection.css';
import './theme.css';
import { followSystemTheme } from './theme';

followSystemTheme();

function App() {
  const { t, locale, setLocale } = useI18n();
  const [books, setBooks] = useState<Book[]>([]), [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [sort, setSort] = useState('recent');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [editingIds, setEditingIds] = useState<string[]>();
  const [selected, setSelected] = useState<string[]>([]);
  const [sources, setSources] = useState<Folder[]>([]);
  const [sourcePicker, setSourcePicker] = useState(false), [settings, setSettings] = useState(false);
  const [delivery, setDelivery] = useState<Delivery>();
  const files = useRef<HTMLInputElement>(null), directory = useRef<HTMLInputElement>(null), restoreInput = useRef<HTMLInputElement>(null);
  const noticeId = useRef(0), operationLock = useRef(false);
  const refresh = async () => { const current = await store.listBooks(); setBooks(current); return current; };
  useEffect(() => {
    Promise.all([refresh(), store.setting<Folder[]>('sources').then(value => setSources(value ?? []))]).then(() => setLoaded(true)).catch(error => { setLoaded(true); setNotice({ text: translatedError(error, t), error: true }); });
  }, []);
  useEffect(() => {
    if (!delivery) return;
    const timeout = setTimeout(() => { setDelivery(undefined); setNotice({ text: t('expired'), error: false }); }, 20 * 60 * 1000);
    const onVisibility = () => { if (document.hidden) setDelivery(undefined); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { clearTimeout(timeout); document.removeEventListener('visibilitychange', onVisibility); };
  }, [delivery, locale]);
  const notify = (text: string, error = false) => {
    const id = ++noticeId.current; setNotice({ text, error });
    if (!error) setTimeout(() => { if (noticeId.current === id) setNotice(undefined); }, 7000);
  };
  const run = async (label: string, action: () => Promise<void>): Promise<boolean> => {
    if (operationLock.current) return false;
    operationLock.current = true; setBusy(label);
    try { await action(); return true; } catch (error) { notify(translatedError(error, t), true); return false; }
    finally { operationLock.current = false; setBusy(''); }
  };
  async function importBytes(name: string, bytes: Uint8Array, source?: { uri: string; modified?: string; folder?: string }) {
    if (bytes.length > MAX_BOOK_SIZE) throw new Error('fileTooLarge');
    const pdf = /\.pdf$/i.test(name);
    if (pdf && new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('Invalid EPUB or PDF');
    const hash = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
    const id = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    const existing = (await store.listBooks()).find(book => book.id === id);
    if (existing) {
      if (source && !existing.sourceUri) await store.saveBook({ ...existing, sourceUri: source.uri, sourceModified: source.modified, sourceFolder: source.folder });
      return { id, added: false, format: existing.format };
    }
    let metadata: Metadata = emptyMetadata(name.replace(/\.(kepub\.)?(epub|pdf)$/i, '')), cover: string | undefined;
    if (!pdf) { const result = await readEpub(bytes); metadata = result.metadata; if (!metadata.title) metadata.title = name; if (result.cover) cover = dataURL(result.cover.bytes, result.cover.mime); }
    const now = new Date().toISOString();
    await store.saveBook({ ...metadata, id, filename: name, format: pdf ? 'pdf' : 'epub', size: bytes.length, added: now, updated: now, cover, sourceUri: source?.uri, sourceModified: source?.modified, sourceFolder: source?.folder }, bytes);
    return { id, added: true, format: pdf ? 'pdf' : 'epub' };
  }
  const openCollection = (ids: string[], current: Book[]) => {
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    const unique = [...new Set(ids)].filter(id => current.some(book => book.id === id && book.format === 'epub'));
    unique.sort((a, b) => collator.compare(current.find(book => book.id === a)!.filename, current.find(book => book.id === b)!.filename));
    if (unique.length) { setEditingIds(unique); setSelected(unique.length > 1 ? unique : []); }
  };
  async function importFiles(input: FileList | null) {
    if (!input?.length) return;
    const list = Array.from(input).filter(file => /\.(epub|pdf)$/i.test(file.name));
    await run(t('importing'), async () => {
      let count = 0, existing = 0; const failures: string[] = [], ids: string[] = [];
      for (let index = 0; index < list.length; index++) {
        const file = list[index]; setBusy(t('reading', { index: index + 1, count: list.length, name: file.name }));
        try {
          if (file.size > MAX_BOOK_SIZE) throw new Error('fileTooLarge');
          const result = await importBytes(file.name, new Uint8Array(await file.arrayBuffer()));
          if (result.added) count++; else existing++; ids.push(result.id);
        } catch (error) { failures.push(file.name + ': ' + translatedError(error, t)); }
      }
      const current = await refresh();
      notify((list.length ? t('imported', { count, existing }) : t('chooseEpub')) + (failures.length ? ' ' + t('failures', { details: failures.join('; ') }) : ''), failures.length > 0);
      openCollection(ids, current);
    });
  }
  async function scanSource(source: Folder) {
    let count = 0, existing = 0; const failures: string[] = [];
    const current = await store.listBooks();
    const { files: list } = await native.scanFolder({ uri: source.uri });
    for (let index = 0; index < list.length; index++) {
      const file = list[index]; setBusy(t('reading', { index: index + 1, count: list.length, name: file.name }));
      if (current.some(book => book.sourceUri === file.uri && book.sourceModified === file.modified && file.modified && file.modified !== '0')) { existing++; continue; }
      try {
        if (file.size > MAX_BOOK_SIZE) throw new Error('fileTooLarge');
        const result = await importBytes(file.name, fromBase64((await native.readDocument({ uri: file.uri })).data), { uri: file.uri, modified: file.modified, folder: source.uri });
        if (result.added) count++; else existing++;
      } catch (error) { failures.push(file.name + ': ' + translatedError(error, t)); }
    }
    await refresh(); notify(source.name + ': ' + t('imported', { count, existing }) + (failures.length ? ' ' + t('failures', { details: failures.join('; ') }) : ''), failures.length > 0);
  }
  const chooseLocal = () => {
    setSourcePicker(false);
    if (!isAndroid) { directory.current?.click(); return; }
    void run(t('openingFolder'), async () => {
      const folder = await native.chooseFolder();
      const next = sources.some(source => source.uri === folder.uri) ? sources : [...sources, folder];
      await store.setSetting('sources', next); setSources(next); await scanSource(folder);
    });
  };
  const saveEdits = (next: Book[]) => run(t('saving'), async () => {
    const updated = new Date().toISOString();
    await store.saveBooks(next.map(book => ({ ...book, updated, edited: true })));
    await refresh(); notify(t('saved'));
  });
  const exportBooks = (next: Book[], kepub: boolean, send = false) => void run(t('preparing'), async () => {
    const result = await exportCollection(next, kepub, send, locale, t, setBusy);
    if (result) setDelivery(result); else notify(t('filesReady'));
  });
  const normalise = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase(locale);
  const filtered = books.filter(book => normalise([book.title, ...book.authors, ...book.tags, book.series, book.publisher].join(' ')).includes(normalise(search)) && (filter === 'all' || filter === book.format || filter === 'series' && !!book.series))
    .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, locale, { numeric: true }) : sort === 'author' ? (a.authors[0] ?? '').localeCompare(b.authors[0] ?? '', locale) : b.added.localeCompare(a.added));
  const editingBooks = editingIds?.map(id => books.find(book => book.id === id)).filter((book): book is Book => !!book);
  const toggleSelected = (id: string) => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" aria-label="Kobo Book Manager"><span className="brand-mark"><BookOpen size={25}/></span><span>kobo<span className="brand-sub">book manager</span></span></a>
      <div className="nav-label">{t('readingSpace')}</div>
      <button className={'nav-item ' + (filter === 'all' ? 'active' : '')} onClick={() => setFilter('all')}><Library size={19}/>{t('library')}<span>{books.length}</span></button>
      <button className={'nav-item ' + (filter === 'series' ? 'active' : '')} onClick={() => setFilter('series')}><BookOpen size={19}/>{t('series')}<span>{new Set(books.map(book => book.series).filter(Boolean)).size}</span></button>
      <div className="nav-label source-heading">{t('folders')}<button aria-label={t('addFolder')} onClick={() => setSourcePicker(true)} disabled={!!busy}><Plus size={16}/></button></div>
      {!sources.length ? <p className="source-empty">{t('folderEmpty')}</p> : sources.map(source => <button className="nav-item source-item" key={source.uri} disabled={!!busy} onClick={() => void run(t('refreshingFolder'), () => scanSource(source))}><FolderOpen size={18}/><span className="source-name">{source.name}</span><RefreshCw size={13}/></button>)}
      <button className="add-folder" onClick={() => setSourcePicker(true)} disabled={!!busy}><Plus size={15}/>{t('addFolder')}</button>
      <div className="sidebar-bottom"><div className="local-note"><span className="status-dot"/>{t('localNote')}</div><button className="nav-item" onClick={() => setSettings(true)}><Settings size={18}/>{t('settings')}</button><span className="version">{t('madeForKobo')} · yujilik · v0.2.4</span></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="mobile-brand"><BookOpen size={22}/>kobo <span>book manager</span></div><span className="breadcrumb">{t('readingSpace')} <span>/</span> {t('library')}</span><div className="topbar-actions"><div className="private-label"><HardDrive size={14}/>{t('localLibrary')}</div><button className="icon-button settings-gear" onClick={() => setSettings(true)} aria-label={t('settings')} title={t('settings')}><Settings size={20}/></button></div></header>
      <div className="page-content">
        <section className="page-heading"><div><p className="eyebrow">{t('eyebrow')}</p><h1>{t(filter === 'series' ? 'yourSeries' : 'yourLibrary')}</h1><p className="subtitle">{t('subtitle')}</p></div><button className="primary" disabled={!!busy} onClick={() => files.current?.click()} aria-label={t('addBooks')}><Plus size={18}/><span>{t('addBooks')}</span></button></section>
        <div className="library-toolbar"><div className="tabs"><button className={filter === 'all' || filter === 'series' ? 'selected' : ''} onClick={() => setFilter('all')}>{t('allBooks')} <span>{books.length}</span></button><button className={filter === 'epub' ? 'selected' : ''} onClick={() => setFilter('epub')}>EPUB / KEPUB</button><button className={filter === 'pdf' ? 'selected' : ''} onClick={() => setFilter('pdf')}>PDF</button></div><button className="icon-button mobile-folder" aria-label={t('openFolder')} onClick={() => setSourcePicker(true)} disabled={!!busy}><FolderOpen size={19}/></button></div>
        <div className="search-row"><label className="search"><Search size={18}/><input placeholder={t('searchPlaceholder')} aria-label={t('search')} value={search} onChange={event => setSearch(event.target.value)}/>{search && <button aria-label={t('clearSearch')} onClick={() => setSearch('')}><X size={15}/></button>}</label><label className="sort"><select aria-label={t('sort')} value={sort} onChange={event => setSort(event.target.value)}><option value="recent">{t('recent')}</option><option value="title">{t('title')}</option><option value="author">{t('author')}</option></select><ChevronDown size={14}/></label><span className="grid-indicator"><LayoutGrid size={18}/></span></div>
        {!!books.length && <div className={'selection-toolbar ' + (selected.length ? 'has-selection' : '')}><span>{t(selected.length ? 'selectedCount' : 'count', { count: selected.length || filtered.length })}</span><div><button className="text-button" disabled={!!busy || !filtered.some(book => book.format === 'epub')} onClick={() => setSelected(current => [...new Set([...current, ...filtered.filter(book => book.format === 'epub').map(book => book.id)])])}><CheckSquare size={15}/>{t('selectAll')}</button>{!!selected.length && <><button className="icon-button" aria-label={t('clearSelection')} onClick={() => setSelected([])}><X size={17}/></button><button className="primary" disabled={!!busy} onClick={() => openCollection(selected, books)}><Layers size={16}/>{t('editSelected')}</button></>}</div></div>}
        {!loaded ? <div className="empty"><LoaderCircle className="spin"/><p>{t('openingLibrary')}</p></div> : !books.length ? <section className="empty-library"><div className="book-illustration" aria-hidden="true"><div className="draw-book back"/><div className="draw-book front"><BookOpen size={39} strokeWidth={1}/></div><span className="draw-line"/></div><p className="eyebrow">{t('firstPage')}</p><h2>{t('emptyTitle')}</h2><p>{t('emptyText')}</p><div className="empty-actions"><button className="primary" disabled={!!busy} onClick={() => setSourcePicker(true)}><FolderOpen size={18}/>{t('openFolder')}</button><button className="secondary" disabled={!!busy} onClick={() => files.current?.click()}><Plus size={18}/>{t('chooseFiles')}</button></div><div className="supported">{t('originalsSafe')}</div></section>
        : !filtered.length ? <section className="empty"><Search size={30}/><h2>{t('noResults')}</h2><p>{t('trySearch')}</p><button className="secondary" onClick={() => { setSearch(''); setFilter('all'); }}>{t('viewAll')}</button></section>
        : <><div className="result-count"><span>{t('editHint')}</span></div><section className="book-grid">{filtered.map(book => <article className={'book-card selectable-book ' + (selected.includes(book.id) ? 'is-selected' : '')} key={book.id}>
          {book.format === 'epub' && <label className="book-selection"><input type="checkbox" checked={selected.includes(book.id)} disabled={!!busy} onChange={() => toggleSelected(book.id)} aria-label={t('selectBook', { title: book.title })}/></label>}
          <button className="book-open" onClick={() => setEditingIds([book.id])} disabled={!!busy} aria-label={t('editBook', { title: book.title })}><div className={'book-cover palette-' + parseInt(book.id[0], 16) % 5}>{book.cover ? <img src={book.cover} alt="" loading="lazy"/> : <div className="cover-type"><BookOpen size={26} strokeWidth={1}/><strong>{book.title}</strong><span>{book.authors.join(', ') || t('unknownAuthor')}</span></div>}<span className="format-badge">{book.format === 'pdf' ? 'PDF' : /\.kepub\.epub$/i.test(book.filename) ? 'KEPUB' : 'EPUB'}</span>{book.edited && <span className="edited-badge" title={t('edited')}><Check size={12}/></span>}</div><h3>{book.title}</h3><p>{book.authors.join(', ') || t('unknownAuthor')}</p>{book.series && <span className="series-label">{book.series}{book.seriesIndex ? ' · ' + book.seriesIndex : ''}</span>}</button>
        </article>)}</section></>}
        {import.meta.env.DEV && <button className="text-button sample-button" disabled={!!busy} onClick={() => void run(t('importing'), async () => {
          const { sampleCollection } = await import('../tests/fixtures'); const ids: string[] = [];
          for (const sample of await sampleCollection()) {
            const existing = (await store.listBooks()).filter(book => book.filename === sample.name).sort((a, b) => Number(!!b.edited) - Number(!!a.edited) || b.updated.localeCompare(a.updated))[0];
            ids.push(existing ? existing.id : (await importBytes(sample.name, sample.bytes)).id);
          }
          const current = await refresh(); openCollection(ids, current); notify(t('sampleLoaded'));
        })}>{t('sample')}</button>}
        <footer className="page-footer"><span><BookOpen size={14}/>{t('footer')}</span><span>EPUB → KEPUB · kepubify</span></footer>
      </div>
    </main>
    <input ref={files} hidden type="file" multiple accept=".epub,.pdf,application/epub+zip,application/pdf" onChange={event => { void importFiles(event.target.files); event.target.value = ''; }}/>
    <input ref={directory} hidden type="file" multiple {...{ webkitdirectory: '' }} onChange={event => { void importFiles(event.target.files); event.target.value = ''; }}/>
    <input ref={restoreInput} hidden type="file" accept=".zip" onChange={event => { const file = event.target.files?.[0]; if (file) void run(t('restoring'), async () => { const count = await store.restore(new Uint8Array(await file.arrayBuffer())); await refresh(); notify(t('restored', { count })); }); event.target.value = ''; }}/>
    {busy && <div className="busy-status" role="status"><LoaderCircle size={18} className="spin"/>{busy}</div>}
    {notice && <div className={'toast ' + (notice.error ? 'error' : '')} role={notice.error ? 'alert' : 'status'}><span>{notice.text}</span><button aria-label={t('dismiss')} onClick={() => setNotice(undefined)}><X size={17}/></button></div>}
    {sourcePicker && <Modal title={t('folderTitle')} onClose={() => setSourcePicker(false)}><p className="modal-intro">{t('folderIntro')}</p>{sources.map(source => <button className="source-choice" key={source.uri} disabled={!!busy} onClick={() => { setSourcePicker(false); void run(t('refreshingFolder'), () => scanSource(source)); }}><FolderOpen size={25}/><span><strong>{source.name}</strong><small>{t('refreshFolder')}</small></span><RefreshCw size={18}/></button>)}<button className="source-choice" onClick={chooseLocal}><FolderOpen size={25}/><span><strong>{t('phoneFolder')}</strong><small>{t('folderStorage')}</small></span><ArrowRight size={18}/></button><p className="hint">{t('safeCopies')}</p></Modal>}
    {settings && <Modal title={t('settings')} onClose={() => setSettings(false)}><div className="settings-section language-section"><div className="settings-language-heading"><Settings size={20}/><h3>{t('appLanguage')}</h3></div><label className="field">{t('appLanguage')}<select aria-label={t('appLanguage')} value={locale} onChange={event => { setLocale(event.target.value as Locale); setNotice(undefined); }}>{locales.map(code => <option key={code} value={code} lang={code}>{localeNames[code]}</option>)}</select></label><p className="hint">{t('languageHint')}</p></div>
      <div className="settings-section"><h3>{t('backupTitle')}</h3><p>{t('backupHint')}</p><div className="button-row"><button className="secondary" disabled={!!busy} onClick={() => void run(t('creatingBackup'), async () => { await saveFile(await store.backup(), 'kebooks-backup-' + new Date().toISOString().slice(0, 10) + '.zip', 'application/zip'); notify(t('backupReady')); })}><FileArchive size={17}/>{t('exportBackup')}</button><button className="secondary" disabled={!!busy} onClick={() => restoreInput.current?.click()}><ArrowDownToLine size={17}/>{t('restore')}</button></div></div>
      <div className="settings-section"><h3>{t('howItWorks')}</h3><ol><li>{t('sendHelp1')}</li><li>{t('sendHelp2')}</li><li>{t('sendHelp3')}</li></ol><p className="hint">{t('networkHint')}</p></div>
      <div className="settings-section"><h3>{t('folders')}</h3>{sources.map(source => <div className="source-setting" key={source.uri}><span><FolderOpen size={17}/>{source.name}</span><button className="text-button" disabled={!!busy} onClick={() => void run(t('disconnecting'), async () => { const next = sources.filter(item => item.uri !== source.uri); await store.setSetting('sources', next); setSources(next); notify(t('disconnected')); })}>{t('disconnect')}</button></div>)}<button className="secondary" disabled={!!busy} onClick={() => { setSettings(false); setSourcePicker(true); }}><Plus size={17}/>{t('addFolder')}</button></div><p className="hint">{t('browserHint')}</p><p className="hint">{t('independent')}</p><p className="hint">© 2026 yujilik · v0.2.4</p>
    </Modal>}
    {!!editingBooks?.length && <CollectionEditor books={editingBooks} busy={!!busy} onClose={() => setEditingIds(undefined)} onSave={saveEdits} onExport={exportBooks} onRemove={book => void run(t('removing'), async () => { await store.removeBook(book.id); await refresh(); setSelected(current => current.filter(id => id !== book.id)); setEditingIds(undefined); notify(t('removed')); })}/>}
    {delivery && <Modal title={t('readyKobo')} onClose={() => { void native.stopDelivery(); setDelivery(undefined); }}><div className="delivery-icon"><Smartphone size={38}/><ArrowRight size={23}/><BookOpen size={38}/></div><p>{t('addressHint')}</p>{delivery.urls.map(url => <code className="delivery-url" key={url}>{url}</code>)}<p>{t('codeHint')}</p><div className="delivery-code">{delivery.code}</div><p className="hint">{t('deliveryHint')}</p><button className="secondary full" onClick={() => { void native.stopDelivery(); setDelivery(undefined); }}>{t('stopDelivery')}</button></Modal>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider><App/></I18nProvider>);

