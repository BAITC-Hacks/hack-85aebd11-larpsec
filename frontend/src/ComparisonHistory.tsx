import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, History, LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react';
import { deleteComparison, listComparisons } from './lib/api';
import { documentCount } from './lib/presentation';
import type { Comparison } from './lib/types';

interface Props {
  activeId?: string;
  disabled: boolean;
  onOpen: (comparison: Comparison) => Promise<void>;
  onDeleted: (id: string) => Promise<void>;
}
const statusLabels: Record<Comparison['status'], string> = {
  draft: 'Подготовка', queued: 'В очереди', running: 'Анализ выполняется', completed: 'Готово', failed: 'Ошибка анализа',
};
const PAGE_SIZE = 20;

export function HistoryDocuments({ documents }: { documents: Comparison['documents'] }) {
  const label = (document: Comparison['documents'][number]) => `${document.side === 'before' ? 'До' : 'После'}: ${document.filename}`;
  return <div className="history-documents"><p>{documents.slice(0, 4).map(label).join(' · ') || 'Документы ещё не загружены'}</p>{documents.length > 4 && <details><summary>И ещё {documents.length - 4}</summary><ul>{documents.slice(4).map((document) => <li key={document.id}>{label(document)}</li>)}</ul></details>}</div>;
}

function DeleteDialog({ comparison, onClose, onDelete }: { comparison: Comparison; onClose: () => void; onDelete: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const remove = async () => {
    setPending(true); setError('');
    try { await onDelete(); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось удалить сравнение.'); }
    finally { setPending(false); }
  };
  return <dialog ref={dialog} className="guide-dialog history-delete-dialog" aria-labelledby="delete-comparison-title" onClose={onClose} onCancel={(event) => { if (pending) event.preventDefault(); }}>
    <div className="dialog-head"><span className="eyebrow">УДАЛЕНИЕ СРАВНЕНИЯ</span><button className="icon-button" disabled={pending} aria-label="Отмена удаления" onClick={onClose}><X size={19} /></button></div>
    <h2 id="delete-comparison-title">Удалить сравнение?</h2>
    <p>«{comparison.title}», {documentCount(comparison.documents.length)}. Документы, результаты и решения экспертов будут удалены с сервера. Восстановить их не получится.</p>
    {error && <p className="analysis-error" role="alert">{error}</p>}
    <div className="history-delete-actions"><button className="button secondary" disabled={pending} onClick={onClose}>Отмена</button><button className="button primary" disabled={pending} onClick={() => void remove()}>{pending ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}Удалить навсегда</button></div>
  </dialog>;
}

export default function ComparisonHistory({ activeId, disabled, onOpen, onDeleted }: Props) {
  const [items, setItems] = useState<Comparison[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Comparison | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void listComparisons(PAGE_SIZE, 0, controller.signal)
      .then((page) => { if (!controller.signal.aborted) { setItems(page); setMore(page.length === PAGE_SIZE); } })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить историю.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const loadMore = async () => {
    setLoading(true); setError('');
    try {
      const page = await listComparisons(PAGE_SIZE, items.length);
      if (mounted.current) {
        setItems((current) => [...current, ...page.filter((item) => !current.some((existing) => existing.id === item.id))]);
        setMore(page.length === PAGE_SIZE);
      }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить историю.'); }
    finally { if (mounted.current) setLoading(false); }
  };
  const open = async (item: Comparison) => {
    setPending(item.id); setError('');
    try { await onOpen(item); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Не удалось открыть сравнение.'); }
    finally { if (mounted.current) setPending(null); }
  };
  return <section className="comparison-history" aria-labelledby="history-heading">
    <div className="analysis-heading-row"><div><span className="eyebrow">СОХРАНЕНО НА СЕРВЕРЕ</span><h2 id="history-heading">История сравнений</h2></div><button className="button secondary compact" disabled={disabled || loading || pending !== null} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={15} />Обновить историю</button></div>
    {error && <div className="inline-error" role="alert"><AlertCircle size={17} /><p>{error}</p></div>}
    {!items.length && !loading && !error && <div className="panel analysis-empty"><History size={27} /><h3>Сохранённых сравнений пока нет</h3><p>После загрузки первого документа сравнение появится здесь.</p></div>}
    <div className="history-list">{items.map((item) => {
      const active = item.status === 'queued' || item.status === 'running';
      return <article className="panel history-card" key={item.id} aria-labelledby={`history-${item.id}`}>
        <div className="history-card-head"><h3 id={`history-${item.id}`}>{item.title}</h3><span className="analysis-tag">{statusLabels[item.status]}</span></div>
        <p className="history-meta">{documentCount(item.documents.length)} · {new Date(item.created_at).toLocaleString('ru-RU')}{activeId === item.id && ' · Открыто сейчас'}</p>
        <HistoryDocuments documents={item.documents} />
        <div className="history-card-actions"><button className="button secondary compact" disabled={disabled || pending !== null} onClick={() => void open(item)}>{pending === item.id ? <LoaderCircle className="spin" size={15} /> : <ArrowRight size={15} />}Открыть сравнение</button><button className="text-button" disabled={disabled || pending !== null || active} title={active ? 'Дождитесь завершения анализа' : undefined} onClick={() => setDeleting(item)}><Trash2 size={15} />Удалить сравнение</button></div>
        {active && <p className="history-meta">Удаление доступно после завершения анализа.</p>}
      </article>;
    })}</div>
    {loading && <p className="history-loading" role="status"><LoaderCircle className="spin" size={17} />Загружаем историю…</p>}
    {more && <button className="button secondary" disabled={disabled || loading || pending !== null} onClick={() => void loadMore()}>Показать ещё</button>}
    {deleting && <DeleteDialog comparison={deleting} onClose={() => setDeleting(null)} onDelete={async () => {
      await deleteComparison(deleting.id);
      setItems((current) => current.filter((item) => item.id !== deleting.id));
      await onDeleted(deleting.id);
      setRevision((value) => value + 1);
    }} />}
  </section>;
}
