import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUp, ArrowDown, BookOpen, Check, ChevronLeft, ChevronRight, FolderOpen, Layers, Save, Send, Trash2 } from 'lucide-react';
import type { Book, ExportFormat, Metadata } from './types';
import { applySharedDetails, draftOf, materialise, moveItem, type Draft, type SharedDetails } from './collection';
import { useI18n } from './i18n';
import { dataURL, isAndroid } from './native';
import { coverMime, MAX_COVER_SIZE } from './cover';
import { Modal } from './Modal';
import { defaultOcrLanguages, ocrLanguageNames, PDF_OCR_LANGUAGES, type PdfOcrLanguage } from './pdf-ocr-options';
import type { ExportOptions } from './export';
const ocrLanguageTags: Record<PdfOcrLanguage, string> = { eng: 'en', jpn: 'ja', chi_sim: 'zh-CN', chi_tra: 'zh-TW', kor: 'ko', tha: 'th', rus: 'ru', por: 'pt', spa: 'es' };

interface Props {
  books: Book[];
  busy: boolean;
  onClose: () => void;
  onSave: (books: Book[]) => Promise<boolean>;
  onExport: (books: Book[], format: ExportFormat, send?: boolean, options?: ExportOptions) => void;
  onRemove: (book: Book) => void;
}
export function CollectionEditor({ books, busy, onClose, onSave, onExport, onRemove }: Props) {
  const { t, locale } = useI18n();
  const [drafts, setDrafts] = useState<Draft[]>(() => books.map(draftOf));
  const [baseline, setBaseline] = useState(() => new Map(books.map(book => [book.id, JSON.stringify(book)])));
  const [activeId, setActiveId] = useState(books[0].id);
  const [tab, setTab] = useState('details');
  const [shared, setShared] = useState(false);
  const [confirm, setConfirm] = useState<'discard' | 'remove'>();
  const [error, setError] = useState('');
  const [pdfFormat, setPdfFormat] = useState<ExportFormat>('kepub');
  const [ocrChoices, setOcrChoices] = useState<Record<string, PdfOcrLanguage[]>>({});
  const coverInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const index = drafts.findIndex(draft => draft.book.id === activeId);
  const active = drafts[index], book = active.book;
  const collection = drafts.length > 1;
  const dirtyIds = new Set(drafts.filter(draft => JSON.stringify(materialise(draft)) !== baseline.get(draft.book.id)).map(draft => draft.book.id));
  const dirty = dirtyIds.size > 0;
  const valid = drafts.every(draft => draft.book.title.trim());
  const pdf = book.format === 'pdf';
  const recognitionLanguages = (source: Book) => ocrChoices[source.id] ?? defaultOcrLanguages(source);
  const ocrLanguages = recognitionLanguages(book);
  const pdfBooks = drafts.map(draft => draft.book).filter(source => source.format === 'pdf');
  const ocrReadyFor = (format: ExportFormat) => format === 'original' || pdfBooks.every(source => recognitionLanguages(source).length > 0);
  const ocrReady = ocrReadyFor(pdf ? pdfFormat : 'kepub');
  const chooseOcrLanguage = (language: PdfOcrLanguage, checked: boolean) => setOcrChoices(current => {
    const selected = new Set(current[book.id] ?? defaultOcrLanguages(book));
    if (checked) selected.add(language); else selected.delete(language);
    return { ...current, [book.id]: PDF_OCR_LANGUAGES.filter(value => selected.has(value)) };
  });
  const exportBooks = (format: ExportFormat, send?: boolean) => {
    const next = drafts.map(materialise);
    if (pdfBooks.length && format !== 'original') {
      if (!ocrReadyFor(format)) return;
      const options: ExportOptions = collection
        ? { pdfByBook: Object.fromEntries(pdfBooks.map(source => [source.id, { ocrLanguages: [...recognitionLanguages(source)] }])) }
        : { ocrLanguages: [...ocrLanguages] };
      onExport(next, format, !!send, options);
    } else if (send === undefined) onExport(next, format);
    else onExport(next, format, send);
  };
  const setDraft = (next: Draft) => setDrafts(current => current.map(draft => draft.book.id === activeId ? next : draft));
  const update = (key: keyof Metadata, value: string) => setDraft({ ...active, book: { ...book, [key]: value } });
  const requestClose = () => { if (busy) return; if (dirty) setConfirm('discard'); else onClose(); };
  useEffect(() => { listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [activeId]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  async function save() {
    if (!valid) { setError(t('titleRequired')); return; }
    const next = drafts.map(materialise);
    if (await onSave(next)) { setBaseline(new Map(next.map(item => [item.id, JSON.stringify(item)]))); setError(''); }
  }
  const field = (key: keyof Metadata, label: string, placeholder = '', area = false) => <label className={'field ' + (area ? 'span-two' : '')}>{label}{area
    ? <textarea value={String(book[key])} placeholder={placeholder} onChange={event => update(key, event.target.value)} rows={5}/>
    : <input value={String(book[key])} placeholder={placeholder} onChange={event => update(key, event.target.value)} required={key === 'title'}/>}</label>;
  async function changeCover(file: File) {
    const id = activeId;
    if (file.size > MAX_COVER_SIZE) { setError(t('coverInvalid')); return; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const image = dataURL(bytes, coverMime(bytes));
      const check = new Image(); check.src = image; await check.decode();
      if (!check.naturalWidth || !check.naturalHeight || check.naturalWidth * check.naturalHeight > 40000000) throw new Error();
      setDrafts(current => current.map(draft => draft.book.id === id ? { ...draft, book: { ...draft.book, cover: image, customCover: image } } : draft)); setError('');
    } catch { setError(t('coverInvalid')); }
  }
  const move = (direction: number) => setDrafts(current => moveItem(current, index, index + direction));
  return <Modal title={collection ? t('collectionTitle') : t('editorTitle')} onClose={requestClose} wide className={collection ? 'collection-modal' : ''}>
    {collection && <p className="collection-intro">{t('collectionHint')}</p>}
    <div className={collection ? 'collection-workspace' : ''}>
      {collection && <aside className="collection-rail" aria-label={t('editSelected')}>
        <div className="rail-heading"><Layers size={16}/><span>{t('count', { count: drafts.length })}</span></div>
        <div className="collection-list" ref={listRef}>{drafts.map((draft, position) => <button key={draft.book.id} className={'collection-item ' + (draft.book.id === activeId ? 'current' : '')} onClick={() => setActiveId(draft.book.id)} aria-current={draft.book.id === activeId ? 'true' : undefined}>
          <span className="collection-number">{String(position + 1).padStart(2, '0')}</span>
          <span className="mini-cover">{draft.book.cover ? <img src={draft.book.cover} alt=""/> : <BookOpen size={15}/>}</span>
          <span className="collection-item-title">{draft.book.title || draft.book.filename}<small>{draft.authorsText.split('\n').filter(Boolean).join(', ') || t('unknownAuthor')}</small></span>
          <span className={'change-indicator ' + (dirtyIds.has(draft.book.id) ? 'pending' : '')} title={dirtyIds.has(draft.book.id) ? t('unsaved') : t('saved')}>{!dirtyIds.has(draft.book.id) && <Check size={11}/>}</span>
        </button>)}</div>
        <div className="reorder-controls"><button className="icon-button" disabled={busy || index === 0} aria-label={t('moveUp')} title={t('moveUp')} onClick={() => move(-1)}><ArrowUp size={15}/></button><button className="icon-button" disabled={busy || index === drafts.length - 1} aria-label={t('moveDown')} title={t('moveDown')} onClick={() => move(1)}><ArrowDown size={15}/></button></div>
        <button className={'shared-toggle ' + (shared ? 'active' : '')} disabled={busy} onClick={() => setShared(!shared)} aria-expanded={shared}><Layers size={17}/>{t('shared')}</button>
      </aside>}
      <div className="collection-content">
        {shared ? <SharedForm key="shared" count={drafts.length} busy={busy} onApply={details => {
          try { setDrafts(current => applySharedDetails(current.map(materialise), details).map(draftOf)); setShared(false); setError(''); } catch { setError(t('numberInvalid')); }
        }}/>
        : <>
          {collection && <div className="book-navigation"><span>{String(index + 1).padStart(2, '0')} <span>/ {String(drafts.length).padStart(2, '0')}</span></span><div><button className="icon-button" disabled={index === 0} aria-label={t('previous')} onClick={() => setActiveId(drafts[index - 1].book.id)}><ChevronLeft size={20}/></button><button className="icon-button" disabled={index === drafts.length - 1} aria-label={t('next')} onClick={() => setActiveId(drafts[index + 1].book.id)}><ChevronRight size={20}/></button></div></div>}
          <div className="editor-layout"><aside className="editor-cover">
            <div className={'book-cover palette-' + parseInt(book.id[0], 16) % 5}>{book.cover ? <img src={book.cover} alt={t('cover')}/> : <div className="cover-type"><BookOpen size={36}/><strong>{book.title}</strong></div>}</div>
            <button className="secondary full" disabled={busy} onClick={() => coverInput.current?.click()}>{t('changeCover')}</button><input ref={coverInput} hidden type="file" accept="image/jpeg,image/png" onChange={event => { const file = event.target.files?.[0]; if (file) void changeCover(file); event.target.value = ''; }}/>
            <p className="hint">{book.format.toUpperCase()} · {new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(book.size / (book.size < 1024 * 1024 ? 1024 : 1024 * 1024))} {book.size < 1024 * 1024 ? 'KB' : 'MB'}<br/>{book.filename}</p>
          </aside><div className="editor-fields">
            <div className="editor-tabs">{(['details', 'organisation', 'exportSend'] as const).map((key, position) => <button key={key} className={tab === ['details', 'organise', 'export'][position] ? 'selected' : ''} onClick={() => setTab(['details', 'organise', 'export'][position])}>{t(key)}</button>)}</div>
            {pdf && tab !== 'export' && <p className="info-note">{t('pdfInfo')}</p>}
            {tab !== 'export' && <form id="book-editor" onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy} className="form-grid">
              {tab === 'details' && <>{field('title', t('title'))}<label className="field">{t('authors')}<textarea value={active.authorsText} onChange={event => setDraft({ ...active, authorsText: event.target.value })} rows={2} placeholder={t('oneAuthorLine')}/></label>{field('language', t('bookLanguage'), 'en, pt-BR, ja…')}{field('publisher', t('publisher'))}{field('description', t('description'), '', true)}</>}
              {tab === 'organise' && <>{field('series', t('seriesName'))}{field('seriesIndex', t('seriesNumber'), '1')}<label className="field span-two">{t('tags')}<input value={active.tagsText} onChange={event => setDraft({ ...active, tagsText: event.target.value })}/><small>{t('tagsHint')}</small></label>{field('isbn', 'ISBN')}{field('published', t('published'), 'YYYY-MM-DD')}</>}
            </fieldset></form>}
            {tab === 'export' && <div className="export-options"><p>{t('exportHint')}</p>{dirty && <p className="info-note">{t('saveBeforeExport')}</p>}
              {pdf && <><label className="field">{t('outputFormat')}<select aria-label={t('outputFormat')} value={pdfFormat} disabled={busy} onChange={event => setPdfFormat(event.target.value as ExportFormat)}><option value="kepub">KEPUB</option><option value="epub">EPUB</option><option value="original">{t(book.customCover ? 'pdfWithCover' : 'originalPdf')}</option></select></label>{pdfFormat !== 'original' ? <><p className="info-note">{t('pdfConversionHint')}</p><details className="ocr-options"><summary>{t('ocrOptions')}</summary><p className="hint">{t('ocrHint')}</p><fieldset className="ocr-languages" aria-label={t('ocrOptions')} disabled={busy}>{PDF_OCR_LANGUAGES.map(language => <label key={language} lang={ocrLanguageTags[language]}><input type="checkbox" checked={ocrLanguages.includes(language)} disabled={busy} onChange={event => chooseOcrLanguage(language, event.target.checked)}/>{ocrLanguageNames[language]}</label>)}</fieldset></details></> : book.customCover && <p className="info-note">{t('pdfCoverHint')}</p>}</>}
              {!ocrReady && <p className="field-error" role="alert">{t('ocrLanguageRequired')}</p>}
              <button className="source-choice" disabled={busy || dirty || !valid || !ocrReady} onClick={() => exportBooks(pdf ? pdfFormat : 'kepub', true)}><Send size={23}/><span><strong>{t(!pdf || pdfFormat === 'kepub' ? 'convertSend' : pdfFormat === 'epub' ? 'convertEpubSend' : 'sendKobo')}</strong><small>{t(!isAndroid ? 'androidOnly' : pdf ? 'readyKobo' : 'convertSendHint')}</small></span><ArrowRight size={17}/></button>
              {!pdf && <button className="source-choice" disabled={busy || dirty || !valid || !ocrReadyFor('kepub')} onClick={() => exportBooks('kepub')}><ArrowDownToLine size={23}/><span><strong>{t(collection ? 'convertZip' : 'convertSave')}</strong><small>{t('readyKobo')}</small></span><ArrowRight size={17}/></button>}
              <button className="source-choice" disabled={busy || dirty || !valid || !ocrReadyFor(pdf ? pdfFormat : 'original')} onClick={() => exportBooks(pdf ? pdfFormat : 'original')}><FolderOpen size={23}/><span><strong>{t(pdf ? pdfFormat === 'original' ? book.customCover ? 'exportPdfCover' : 'exportPdf' : pdfFormat === 'epub' ? 'convertEpubSave' : 'convertSave' : collection ? 'exportZip' : /\.kepub\.epub$/i.test(book.filename) ? 'exportKepub' : 'exportEpub')}</strong><small>{t('originalsPreserved')}</small></span><ArrowRight size={17}/></button>
              {book.customCover && <p className="hint">{t('koboCoverHint')}</p>}
            </div>}
          </div></div>
        </>}
      </div>
    </div>
    {error && <p className="field-error" role="alert">{error}</p>}
    {confirm && <div className="delete-confirm" role="alert"><p>{t(confirm === 'discard' ? 'discardConfirm' : 'removeConfirm')}</p><div className="button-row"><button className="secondary" onClick={() => setConfirm(undefined)}>{t('keepEditing')}</button><button className="primary danger-bg" disabled={busy} onClick={() => confirm === 'discard' ? onClose() : onRemove(book)}>{t(confirm === 'discard' ? 'discard' : 'remove')}</button></div></div>}
    <div className="editor-bottom">
      {collection ? <span className={'save-state ' + (dirty ? 'pending' : '')}><span className="status-dot"/>{t(dirty ? 'unsaved' : 'saved')}</span> : <button className="danger text-button" disabled={busy} onClick={() => setConfirm('remove')}><Trash2 size={15}/>{t('remove')}</button>}
      <div className="button-row"><button className="secondary" onClick={requestClose} disabled={busy}>{t('close')}</button><button className="primary" disabled={busy || !valid || !dirty} onClick={() => void save()}><Save size={16}/>{t(collection ? 'saveAll' : 'save')}</button></div>
    </div>
  </Modal>;
}

function SharedForm({ count, busy, onApply }: { count: number; busy: boolean; onApply: (details: SharedDetails) => void }) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<string[]>([]);
  const [values, setValues] = useState({ authors: '', series: '', language: '', publisher: '', tags: '', startNumber: '1' });
  const [append, setAppend] = useState(true);
  const labels = { authors: t('authors'), series: t('seriesName'), language: t('bookLanguage'), publisher: t('publisher'), tags: t('tags'), startNumber: t('numberFrom') };
  return <form className="shared-form" onSubmit={event => {
    event.preventDefault();
    const details: SharedDetails = {};
    for (const key of ['series', 'language', 'publisher'] as const) if (enabled.includes(key)) details[key] = values[key];
    if (enabled.includes('authors')) details.authors = values.authors.split('\n').map(x => x.trim()).filter(Boolean);
    if (enabled.includes('tags')) { details.tags = values.tags.split(',').map(x => x.trim()).filter(Boolean); details.appendTags = append; }
    if (enabled.includes('startNumber')) details.startNumber = values.startNumber.trim() ? Number(values.startNumber) : NaN;
    onApply(details);
  }}><p className="eyebrow">{t('shared')}</p><h3>{t('applyAll', { count })}</h3><p>{t('sharedHint')}</p>
    <fieldset disabled={busy} className="shared-fields">{Object.entries(labels).map(([name, label]) => {
      const key = name as keyof typeof values;
      return <div className={'shared-field ' + (enabled.includes(key) ? 'enabled' : '')} key={key}><label className="shared-check"><input type="checkbox" checked={enabled.includes(key)} onChange={event => setEnabled(current => event.target.checked ? [...current, key] : current.filter(x => x !== key))}/>{label}</label>
        {key === 'authors' ? <textarea aria-label={label} disabled={!enabled.includes(key)} value={values[key]} onChange={event => setValues({ ...values, [key]: event.target.value })} rows={2} placeholder={t('oneAuthorLine')}/>
        : <input aria-label={label} disabled={!enabled.includes(key)} value={values[key]} onChange={event => setValues({ ...values, [key]: event.target.value })} type={key === 'startNumber' ? 'number' : 'text'} min={key === 'startNumber' ? 0 : undefined} step={key === 'startNumber' ? 'any' : undefined}/>}
      </div>;
    })}</fieldset>
    {enabled.includes('tags') && <label className="append-tags"><input type="checkbox" checked={append} onChange={event => setAppend(event.target.checked)}/>{t('appendTags')}</label>}
    <p className="hint">{t('orderHint')}</p><button className="primary" type="submit" disabled={busy || !enabled.length}><Check size={17}/>{t('applyAll', { count })}</button>
  </form>;
}
