import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDown, ArrowRight, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, FileText, GitCompareArrows, LoaderCircle, Minus, Plus, RotateCcw } from 'lucide-react';
import type { WorkspaceDocument } from './lib/types';
import type { DiffLine, TextDiff } from './lib/textDiff';
import './document-diff.css';

interface Props {
  documents: WorkspaceDocument[];
  onDocuments: () => void;
}

type ReadyDocument = WorkspaceDocument & { result: NonNullable<WorkspaceDocument['result']> };
type Calculation = {
  before: string;
  after: string;
  beforeXlsx: boolean;
  afterXlsx: boolean;
  attempt: number;
} & ({ status: 'loading' } | { status: 'error' } | { status: 'ready'; result: TextDiff });

const PAGE_SIZE = 200;
const number = (value: number) => value.toLocaleString('ru-RU');

type ExtractionWarning = { key: string; side: string; name: string; text: string };

function ExtractionWarnings({ warnings }: { warnings: ExtractionWarning[] }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  return <details className="document-diff-warnings" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><AlertCircle size={17} /><span>Предупреждения при извлечении текста: {number(warnings.length)}</span><ChevronDown size={16} /></summary>
    {open && <>
      <ul>{(showAll ? warnings : warnings.slice(0, 8)).map((warning) => <li key={warning.key}><strong>{warning.side} · {warning.name}</strong><p>{warning.text}</p></li>)}</ul>
      {warnings.length > 8 && <button className="text-button document-diff-warnings-toggle" type="button" onClick={() => setShowAll((value) => !value)}>{showAll ? 'Свернуть список' : `Показать остальные (${number(warnings.length - 8)})`}</button>}
    </>}
  </details>;
}

function Line({ line, side, changed }: { line: DiffLine | null; side: 'before' | 'after'; changed: boolean }) {
  if (!line) return <div className="document-diff-line document-diff-gap"><span className="visually-hidden">Нет соответствующей строки</span></div>;
  const sign = changed ? side === 'before' ? '−' : '+' : '';
  return <div className="document-diff-line">
    <span className="document-diff-line-number" aria-label={`Строка ${line.number}`}>{line.number}</span>
    <span className="document-diff-sign" aria-hidden="true">{sign}</span>
    <span className="document-diff-line-text">
      {changed && <span className="visually-hidden">{side === 'before' ? 'Удалено: ' : 'Добавлено: '}</span>}
      {line.segments.length ? line.segments.map((segment, index) => segment.changed
        ? <mark key={index}>{segment.text}</mark>
        : <span key={index}>{segment.text}</span>) : line.text || '\u00a0'}
    </span>
  </div>;
}

function Comparison({ before, after }: { before: ReadyDocument; after: ReadyDocument }) {
  const beforeText = before.result.text;
  const afterText = after.result.text;
  const beforeXlsx = before.name.toLowerCase().endsWith('.xlsx');
  const afterXlsx = after.name.toLowerCase().endsWith('.xlsx');
  const beforeFragments = useMemo(() => beforeXlsx ? before.result.paragraphs.map((paragraph) => paragraph.text) : undefined, [beforeXlsx, before.result.paragraphs]);
  const afterFragments = useMemo(() => afterXlsx ? after.result.paragraphs.map((paragraph) => paragraph.text) : undefined, [afterXlsx, after.result.paragraphs]);
  const beforeFragmentLocators = useMemo(() => beforeXlsx ? before.result.paragraphs.map((paragraph) => paragraph.locator) : undefined, [beforeXlsx, before.result.paragraphs]);
  const afterFragmentLocators = useMemo(() => afterXlsx ? after.result.paragraphs.map((paragraph) => paragraph.locator) : undefined, [afterXlsx, after.result.paragraphs]);
  const [attempt, setAttempt] = useState(0);
  const [calculation, setCalculation] = useState<Calculation>({ status: 'loading', before: beforeText, after: afterText, beforeXlsx, afterXlsx, attempt });
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [page, setPage] = useState(0);
  const [activeBlock, setActiveBlock] = useState(-1);
  const [targetId, setTargetId] = useState<string | null>(null);
  const requestId = useRef(0);
  const viewport = useRef<HTMLDivElement>(null);
  const tableHead = useRef<HTMLTableSectionElement>(null);
  const rowElements = useRef(new Map<string, HTMLTableRowElement>());
  const paginationId = useId();
  const calculationCurrent = calculation.before === beforeText && calculation.after === afterText && calculation.beforeXlsx === beforeXlsx && calculation.afterXlsx === afterXlsx && calculation.attempt === attempt;
  const result = calculation.status === 'ready' && calculationCurrent ? calculation.result : null;
  const failed = calculation.status === 'error' && calculationCurrent;

  useEffect(() => {
    const id = ++requestId.current;
    let disposed = false;
    let worker: Worker | undefined;
    const source = { before: beforeText, after: afterText, beforeXlsx, afterXlsx, attempt };
    setCalculation({ ...source, status: 'loading' });
    setPage(0);
    setActiveBlock(-1);
    setTargetId(null);
    const fail = () => {
      if (!disposed && id === requestId.current) setCalculation({ ...source, status: 'error' });
      worker?.terminate();
    };
    try {
      worker = new Worker(new URL('./workers/textDiff.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ id: number; result?: TextDiff; error?: string }>) => {
        if (disposed || event.data.id !== id || id !== requestId.current) return;
        if (event.data.result) {
          setCalculation({ ...source, status: 'ready', result: event.data.result });
          worker?.terminate();
        } else fail();
      };
      worker.onerror = fail;
      worker.onmessageerror = fail;
      worker.postMessage({ id, before: beforeText, after: afterText, options: {
        beforeFormat: beforeXlsx ? 'xlsx' : 'text',
        afterFormat: afterXlsx ? 'xlsx' : 'text',
        beforeFragments,
        afterFragments,
        beforeFragmentLocators,
        afterFragmentLocators,
      } });
    } catch {
      fail();
    }
    return () => { disposed = true; worker?.terminate(); };
  }, [beforeText, afterText, beforeXlsx, afterXlsx, beforeFragments, afterFragments, beforeFragmentLocators, afterFragmentLocators, attempt]);

  const blocks = useMemo(() => {
    const starts: string[] = [];
    let changing = false;
    for (const row of result?.rows ?? []) {
      if (row.kind !== 'equal' && !changing) starts.push(row.id);
      changing = row.kind !== 'equal';
    }
    return starts;
  }, [result]);
  const visibleRows = useMemo(() => result ? onlyChanges ? result.rows.filter((row) => row.kind !== 'equal') : result.rows : [], [result, onlyChanges]);
  const rowPositions = useMemo(() => new Map(visibleRows.map((row, index) => [row.id, index])), [visibleRows]);
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = visibleRows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  useEffect(() => {
    const container = viewport.current;
    if (!container) return;
    if (targetId) {
      const row = rowElements.current.get(targetId);
      if (row) {
        const top = container.scrollTop + row.getBoundingClientRect().top - container.getBoundingClientRect().top - (tableHead.current?.offsetHeight ?? 0) - 10;
        container.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
        row.focus({ preventScroll: true });
      }
    } else container.scrollTo({ top: 0, behavior: 'auto' });
  }, [currentPage, targetId, onlyChanges, result]);

  const goToBlock = (index: number) => {
    const id = blocks[index];
    const position = rowPositions.get(id);
    if (position === undefined) return;
    setActiveBlock(index);
    setPage(Math.floor(position / PAGE_SIZE));
    setTargetId(id);
  };
  const goToPage = (value: number) => {
    setPage(Math.max(0, Math.min(pageCount - 1, value)));
    setTargetId(null);
    setActiveBlock(-1);
  };

  if (failed) return <div className="document-diff-state panel" role="alert">
    <AlertCircle size={28} />
    <h3>Не удалось сравнить текст</h3>
    <p>Повторите сравнение. Если ошибка останется, выберите другую пару документов.</p>
    <button className="button secondary" type="button" onClick={() => setAttempt((value) => value + 1)}><RotateCcw size={16} />Повторить сравнение</button>
  </div>;
  if (!result) return <div className="document-diff-state panel" role="status" aria-live="polite">
    <LoaderCircle className="spin" size={28} /><h3>Сопоставляем текст</h3><p>Ищем добавленные, удалённые и изменённые строки. Для большого документа потребуется немного времени.</p>
  </div>;

  const identical = result.changeBlocks === 0;
  const emptyTexts = !beforeText.trim() && !afterText.trim();
  return <div className="document-diff-result">
    <div className="document-diff-stats" aria-label="Итоги сравнения текста">
      <div className="document-diff-stat document-diff-stat-removed"><span><Minus size={15} />Удалено строк</span><strong>{number(result.removedLines)}</strong></div>
      <div className="document-diff-stat document-diff-stat-added"><span><Plus size={15} />Добавлено строк</span><strong>{number(result.addedLines)}</strong></div>
      <div className="document-diff-stat"><span><GitCompareArrows size={15} />Блоков изменений</span><strong>{number(result.changeBlocks)}</strong></div>
    </div>
    {identical && <div className={`document-diff-identical${emptyTexts ? ' document-diff-no-text' : ''}`} role="status">
      {emptyTexts ? <AlertCircle size={19} /> : <Check size={19} />}
      <div><strong>{emptyTexts ? 'Нет текста для сравнения' : 'Текстовых изменений не найдено'}</strong><p>{emptyTexts ? 'В обоих документах отсутствует извлечённый текст. Проверьте документы и предупреждения об обработке.' : 'Добавленных и удалённых строк нет. Различия в пробелах и пустых строках не выделяются.'}</p></div>
    </div>}
    <div className="document-diff-toolbar">
      <label className="document-diff-filter"><input type="checkbox" checked={onlyChanges} onChange={(event) => { setOnlyChanges(event.target.checked); setPage(0); setTargetId(null); setActiveBlock(-1); }} />Только изменения</label>
      <div className="document-diff-navigation" aria-label="Переход между изменениями">
        <span aria-live="polite">{blocks.length ? activeBlock < 0 ? `${number(blocks.length)} блоков изменений` : `Блок ${number(activeBlock + 1)} из ${number(blocks.length)}` : 'Нет изменений'}</span>
        <button className="document-diff-icon-button" type="button" disabled={activeBlock <= 0} onClick={() => goToBlock(activeBlock - 1)} aria-label="Предыдущий блок изменений" title="Предыдущий блок изменений"><ArrowUp size={17} /></button>
        <button className="document-diff-icon-button" type="button" disabled={!blocks.length || activeBlock >= blocks.length - 1} onClick={() => goToBlock(activeBlock + 1)} aria-label="Следующий блок изменений" title="Следующий блок изменений"><ArrowDown size={17} /></button>
      </div>
    </div>
    <div className="document-diff-legend" aria-label="Обозначения"><span className="document-diff-legend-removed"><Minus size={14} />Удалено в версии «до»</span><span className="document-diff-legend-added"><Plus size={14} />Добавлено в версии «после»</span><span>Изменённая строка показана с обеих сторон</span></div>
    {visibleRows.length ? <>
      <p className="document-diff-mobile-hint">Прокрутите область вправо, чтобы увидеть вторую версию.</p>
      <div className="document-diff-viewport" ref={viewport} tabIndex={0} role="region" aria-label="Текст документов до и после, общая прокрутка">
        <table className="document-diff-table">
          <caption className="visually-hidden">Сравнение извлечённого текста: {before.name} и {after.name}. Номера относятся к строкам текста.</caption>
          <thead ref={tableHead}><tr><th scope="col"><span className="document-diff-side-label">ДО</span><span title={before.name}>{before.name}</span></th><th scope="col"><span className="document-diff-side-label">ПОСЛЕ</span><span title={after.name}>{after.name}</span></th></tr></thead>
          <tbody>{pageRows.map((row) => <tr key={row.id} ref={(element) => { if (element) rowElements.current.set(row.id, element); else rowElements.current.delete(row.id); }} tabIndex={-1} className={`document-diff-row document-diff-row-${row.kind}${targetId === row.id ? ' document-diff-row-active' : ''}`}>
            <td className={row.kind === 'removed' || row.kind === 'modified' ? 'document-diff-cell-removed' : row.before ? '' : 'document-diff-cell-empty'}><Line line={row.before} side="before" changed={row.kind === 'removed' || row.kind === 'modified'} /></td>
            <td className={row.kind === 'added' || row.kind === 'modified' ? 'document-diff-cell-added' : row.after ? '' : 'document-diff-cell-empty'}><Line line={row.after} side="after" changed={row.kind === 'added' || row.kind === 'modified'} /></td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="document-diff-pagination">
        <p>Строки сравнения {number(currentPage * PAGE_SIZE + 1)}–{number(Math.min((currentPage + 1) * PAGE_SIZE, visibleRows.length))} из {number(visibleRows.length)}</p>
        {pageCount > 1 && <div className="document-diff-page-controls">
          <button className="document-diff-icon-button" type="button" disabled={currentPage === 0} onClick={() => goToPage(currentPage - 1)} aria-label="Предыдущая часть текста"><ChevronLeft size={17} /></button>
          <label htmlFor={paginationId}>Часть</label><select id={paginationId} value={currentPage} onChange={(event) => goToPage(Number(event.target.value))}>{Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>{index + 1} из {pageCount}</option>)}</select>
          <button className="document-diff-icon-button" type="button" disabled={currentPage === pageCount - 1} onClick={() => goToPage(currentPage + 1)} aria-label="Следующая часть текста"><ChevronRight size={17} /></button>
        </div>}
      </div>
      <p className="document-diff-footnote">Номера относятся к строкам этого просмотра. Пустые строки, различия в пробелах, форматирование и изображения не выделяются.{(beforeXlsx || afterXlsx) && ' В Excel сдвиг номеров строк в адресах ячеек не считается изменением; адреса и значения показаны как в источнике.'}</p>
    </> : !emptyTexts && <div className="document-diff-filter-empty panel"><Check size={22} /><p>В выбранной паре нет изменённых строк.</p><button className="text-button" type="button" onClick={() => setOnlyChanges(false)}>Показать весь текст <ArrowRight size={15} /></button></div>}
  </div>;
}

export default function DocumentDiff({ documents, onDocuments }: Props) {
  const [beforeId, setBeforeId] = useState('');
  const [afterId, setAfterId] = useState('');
  const beforeSelectId = useId();
  const afterSelectId = useId();
  const ready = useMemo(() => documents.filter((document): document is ReadyDocument => document.status === 'ready' && document.result !== undefined), [documents]);
  const beforeDocuments = ready.filter((document) => document.phase === 'before');
  const afterDocuments = ready.filter((document) => document.phase === 'after');
  const before = beforeDocuments.find((document) => document.id === beforeId) ?? beforeDocuments[0];
  const after = afterDocuments.find((document) => document.id === afterId) ?? afterDocuments[0];
  const warnings = [before, after].flatMap((document) => document ? document.result.warnings.map((text, index) => ({ key: `${document.id}-${index}`, side: document.phase === 'before' ? 'До' : 'После', name: document.name, text })) : []);

  return <section className="document-diff" aria-label="Текстовое сравнение документов">
    <div className="document-diff-heading"><div><span className="eyebrow">ДВЕ ВЕРСИИ РЯДОМ</span><h2>Что изменилось в тексте</h2><p>Сравните формулировки и найдите нужное изменение.</p></div><button className="button secondary" type="button" onClick={onDocuments}><FileText size={16} />К документам</button></div>
    <div className="document-diff-selectors panel">
      <label htmlFor={beforeSelectId}><span>До изменений</span><select id={beforeSelectId} value={before?.id ?? ''} onChange={(event) => setBeforeId(event.target.value)} disabled={!beforeDocuments.length}>{beforeDocuments.length ? beforeDocuments.map((document) => <option key={document.id} value={document.id}>{document.name}</option>) : <option value="">Нет обработанных документов</option>}</select></label>
      <label htmlFor={afterSelectId}><span>После изменений</span><select id={afterSelectId} value={after?.id ?? ''} onChange={(event) => setAfterId(event.target.value)} disabled={!afterDocuments.length}>{afterDocuments.length ? afterDocuments.map((document) => <option key={document.id} value={document.id}>{document.name}</option>) : <option value="">Нет обработанных документов</option>}</select></label>
      <p>Сравниваем извлечённый текст: цвет показывает изменения формулировок. Выводы о функциях и подразделениях — во вкладке «Анализ функций».</p>
    </div>
    {warnings.length > 0 && <ExtractionWarnings key={`warnings:${before?.id}:${after?.id}`} warnings={warnings} />}
    {before && after ? <Comparison key={`${before.id}:${after.id}`} before={before} after={after} /> : <div className="document-diff-state panel"><GitCompareArrows size={30} /><h3>Подготовьте две версии документа</h3><p>Загрузите и обработайте хотя бы один документ «до» и один «после». Затем выберите пару для сравнения текста.</p><button className="button primary" type="button" onClick={onDocuments}>Добавить документы <ArrowRight size={16} /></button></div>}
  </section>;
}
