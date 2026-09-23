import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowRight, BookOpen, Check, CheckCheck, ChevronDown, FileText, GitCompareArrows, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import { downloadReport, getSource, reviewFinding } from './lib/api';
import type { AnalysisResult, Comparison, Evidence, Finding, Fragment, FunctionRecord, ReviewRecord, ReviewStatus, WorkspaceDocument } from './lib/types';
import { findTextRepetitions } from './lib/textRepetitions';
import TextRepetitions from './TextRepetitions';
import './comparison.css';

interface Props {
  comparison: Comparison;
  result: AnalysisResult;
  documents: WorkspaceDocument[];
  documentsLoading: boolean;
  onRefresh: () => Promise<void>;
}

const findingLabels = {
  potential_loss: 'Возможная потеря',
  duplication: 'Дублирование функций',
  conflict: 'Противоречие',
  coverage_gap: 'Недостаточно данных',
};
const functionLabels = {
  preserved: 'Сохранена', moved: 'Передана', modified: 'Изменена',
  potential_loss: 'Возможная потеря', unmatched: 'Нет соответствия', added: 'Добавлена',
};
const unitLabels = {
  preserved: 'Сохранено', renamed: 'Переименовано', merged: 'Объединено',
  split: 'Разделено', reorganized: 'Реорганизовано', created: 'Создано', unmatched: 'Нет соответствия',
};
const reviewLabels: Record<ReviewStatus, string> = {
  unreviewed: 'Ожидает проверки', confirmed: 'Подтверждено экспертом', dismissed: 'Отклонено экспертом',
};
const kindLabels = { duty: 'Обязанность', permission: 'Право', prohibition: 'Запрет' };
const sideLabels = { before: 'До изменений', after: 'После изменений' };

function message(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

function EvidenceList({ evidence, comparison, onOpen }: { evidence: Evidence[]; comparison: Comparison; onOpen: (evidence: Evidence) => void }) {
  if (!evidence.length) return null;
  return <details className="analysis-evidence">
    <summary><BookOpen size={15} />Источники <span>{evidence.length}</span><ChevronDown size={15} /></summary>
    <div className="analysis-evidence-list">
      {evidence.map((item, index) => {
        const document = comparison.documents.find((doc) => item.fragment_id.startsWith(`${doc.id}:`));
        return <div className="analysis-evidence-item" key={`${item.fragment_id}-${index}`}>
          <blockquote>{item.quote}</blockquote>
          <button className="text-button" onClick={() => onOpen(item)}>
            <FileText size={14} /><span>{document ? `${sideLabels[document.side]} · ${document.filename}` : 'Открыть источник'}</span><ArrowRight size={14} />
          </button>
        </div>;
      })}
    </div>
  </details>;
}

function SourceDialog({ comparison, evidence, onClose }: { comparison: Comparison; evidence: Evidence; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [fragment, setFragment] = useState<Fragment | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void getSource(comparison.id, evidence.fragment_id)
      .then((value) => { if (active) setFragment(value); })
      .catch((reason: unknown) => { if (active) setError(message(reason, 'Не удалось загрузить источник.')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [comparison.id, evidence.fragment_id, attempt]);
  const document = comparison.documents.find((doc) => doc.id === fragment?.document_id);
  const quoteIndex = fragment?.text.indexOf(evidence.quote) ?? -1;
  return <dialog ref={dialog} className="analysis-source-dialog" aria-labelledby="source-heading" onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
    <div className="dialog-head"><span className="eyebrow">ПОДТВЕРЖДЕНИЕ ИЗ ДОКУМЕНТА</span><button className="icon-button" aria-label="Закрыть источник" onClick={() => dialog.current?.close()}><X size={20} /></button></div>
    <h2 id="source-heading">Источник вывода</h2>
    {loading ? <div className="analysis-source-loading" role="status"><LoaderCircle className="spin" size={22} />Загружаем фрагмент с сервера…</div> : error ? <div className="analysis-source-error"><p role="alert">{error}</p><button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Повторить загрузку источника</button></div> : fragment && <>
      <div className="analysis-source-meta"><strong>{document?.filename ?? 'Исходный документ'}</strong><span>{document && `${sideLabels[document.side]} · `}{fragment.locator}</span></div>
      <dl className="analysis-source-locator">
        {fragment.clause && <div><dt>Пункт</dt><dd>{fragment.clause}</dd></div>}
        {fragment.page !== null && <div><dt>Страница</dt><dd>{fragment.page}</dd></div>}
        {fragment.sheet && <div><dt>Лист</dt><dd>{fragment.sheet}</dd></div>}
        {fragment.cell_range && <div><dt>Ячейки</dt><dd>{fragment.cell_range}</dd></div>}
      </dl>
      <h3>Полный фрагмент</h3>
      <div className="analysis-source-text" data-testid="source-fragment">{quoteIndex >= 0 ? <>{fragment.text.slice(0, quoteIndex)}<mark>{fragment.text.slice(quoteIndex, quoteIndex + evidence.quote.length)}</mark>{fragment.text.slice(quoteIndex + evidence.quote.length)}</> : fragment.text}</div>
      {quoteIndex < 0 && <><h3>Цитата в выводе</h3><blockquote className="analysis-source-text">{evidence.quote}</blockquote></>}
      <p className="analysis-source-note"><ShieldCheck size={15} />Текст получен из сохранённого на сервере документа.</p>
    </>}
  </dialog>;
}

function FindingCard({ finding, review, comparison, onOpen, onRefresh }: { finding: Finding; review?: ReviewRecord; comparison: Comparison; onOpen: (evidence: Evidence) => void; onRefresh: () => Promise<void> }) {
  const [status, setStatus] = useState<ReviewStatus>(review?.status ?? 'unreviewed');
  const [comment, setComment] = useState(review?.comment ?? '');
  const [savedComment, setSavedComment] = useState(review?.comment ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setStatus(review?.status ?? 'unreviewed');
    setComment(review?.comment ?? '');
    setSavedComment(review?.comment ?? '');
  }, [review?.status, review?.comment, review?.updated_at]);

  const save = async (nextStatus: ReviewStatus) => {
    setPending(true); setError(''); setSaved(false);
    try {
      const updated = await reviewFinding(comparison.id, finding.id, nextStatus, comment);
      setStatus(updated.status); setComment(updated.comment); setSavedComment(updated.comment); setSaved(true);
      try { await onRefresh(); }
      catch (reason) { setError(`Решение сохранено. Не удалось обновить отчёт: ${message(reason, 'попробуйте обновить страницу.')}`); }
    } catch (reason) { setError(message(reason, 'Не удалось сохранить решение.')); }
    finally { setPending(false); }
  };

  return <article className={`panel analysis-finding finding-${finding.kind}`} aria-labelledby={`finding-${finding.id}`}>
    <div className="analysis-card-top"><span className={`analysis-tag tag-${finding.kind}`}><AlertCircle size={13} />{findingLabels[finding.kind]}</span><span className={`analysis-review-status review-${status}`}>{status === 'confirmed' && <Check size={13} />}{reviewLabels[status]}</span></div>
    <h3 id={`finding-${finding.id}`}>{finding.title}</h3>
    <p className="analysis-explanation">{finding.explanation}</p>
    <div className="analysis-recommendation"><span className="eyebrow">ЧТО ПРОВЕРИТЬ</span><p>{finding.recommendation}</p></div>
    <EvidenceList evidence={finding.evidence} comparison={comparison} onOpen={onOpen} />
    <div className="analysis-review">
      <label htmlFor={`comment-${finding.id}`}>Комментарий эксперта</label>
      <textarea id={`comment-${finding.id}`} rows={2} maxLength={2000} value={comment} disabled={pending} placeholder="Что подтвердилось и что нужно уточнить…" onChange={(event) => { setComment(event.target.value); setSaved(false); }} />
      <div className="analysis-review-actions">
        <button className="button secondary compact" disabled={pending || (status === 'confirmed' && comment === savedComment)} onClick={() => void save('confirmed')}><Check size={15} />Подтвердить</button>
        <button className="button secondary compact" disabled={pending || (status === 'dismissed' && comment === savedComment)} onClick={() => void save('dismissed')}><X size={15} />Отклонить</button>
        {status !== 'unreviewed' && <button className="text-button" disabled={pending} onClick={() => void save('unreviewed')}>Снять решение</button>}
        {comment !== savedComment && <button className="text-button" disabled={pending} onClick={() => void save(status)}>Сохранить комментарий</button>}
        {pending && <span className="analysis-save-state" role="status"><LoaderCircle size={15} className="spin" />Сохраняем…</span>}
        {saved && !pending && <span className="analysis-save-state" role="status"><CheckCheck size={15} />Сохранено на сервере</span>}
      </div>
      {error && <p className="analysis-error" role="alert">{error}</p>}
    </div>
  </article>;
}

function FunctionDetails({ item }: { item: FunctionRecord }) {
  return <div className="analysis-function-detail"><strong>{item.owner}</strong><span className={`analysis-function-kind kind-${item.kind}`}>{kindLabels[item.kind]}</span><p>{item.action}</p>{item.object && <p><span>Объект:</span> {item.object}</p>}{item.scope && <p><span>Область:</span> {item.scope}</p>}</div>;
}

export default function ComparisonResults({ comparison, result, documents, documentsLoading, onRefresh }: Props) {
  const [tab, setTab] = useState<'findings' | 'functions' | 'units' | 'repetitions'>('findings');
  const [findingFilter, setFindingFilter] = useState<'all' | Finding['kind']>('all');
  const [source, setSource] = useState<Evidence | null>(null);
  const [downloading, setDownloading] = useState<'markdown' | 'json' | null>(null);
  const [downloadError, setDownloadError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [comparison.id]);
  const functions = new Map(result.functions.map((item) => [item.id, item]));
  const units = new Map(result.units.map((item) => [item.id, item]));
  const reviews = new Map(result.reviews.map((item) => [item.finding_id, item]));
  const repetitions = useMemo(() => findTextRepetitions(documents), [documents]);
  const afterRepetitions = repetitions.filter((item) => item.side === 'after');
  const sourceDocuments = comparison.documents.map((item) => documents.find((document) => document.serverId === item.id));
  const sourcesPending = documentsLoading || sourceDocuments.some((document) => document?.status === 'processing' || document?.status === 'uploading');
  const unavailableSides = (['before', 'after'] as const).filter((side) => comparison.documents.some((item) => item.side === side && !documents.some((document) => document.serverId === item.id && document.status === 'ready' && document.result)));
  const visibleFindings = findingFilter === 'all' ? result.findings : result.findings.filter((item) => item.kind === findingFilter);
  const focusContent = () => requestAnimationFrame(() => {
    content.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    content.current?.focus({ preventScroll: true });
  });
  const showFindingKind = (kind: Finding['kind']) => { setFindingFilter(kind); setTab('findings'); focusContent(); };
  const showRepetitions = () => { setTab('repetitions'); focusContent(); };
  const download = async (format: 'markdown' | 'json') => {
    setDownloading(format); setDownloadError('');
    try { await downloadReport(comparison.id, format); }
    catch (reason) { setDownloadError(message(reason, 'Не удалось скачать отчёт.')); }
    finally { setDownloading(null); }
  };

  return <section className="analysis-results" aria-label="Результат сравнения">
    <div className="analysis-heading-row"><div><span className="eyebrow">СРАВНЕНИЕ ЗАВЕРШЕНО</span><h2 ref={heading} tabIndex={-1}>Изменения и выводы</h2><p>{comparison.title}</p></div><div className="analysis-downloads"><button className="button secondary compact" disabled={downloading !== null} onClick={() => void download('markdown')}>{downloading === 'markdown' ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}Скачать отчёт</button><button className="button secondary compact" disabled={downloading !== null} onClick={() => void download('json')}>{downloading === 'json' ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}JSON</button></div></div>
    {downloadError && <p className="analysis-error" role="alert">{downloadError}</p>}
    <div className={`notice analysis-mode ${result.mode === 'demo' ? 'example-notice' : ''}`}><ShieldCheck size={19} /><div><strong>{result.mode === 'demo' ? 'Демонстрационный анализ' : 'Анализ с языковой моделью'}</strong><p>{result.mode === 'demo' ? 'Сервер сравнил документы по формальным правилам. Свободные формулировки могут быть распознаны не полностью; выводы нужно проверить по источникам.' : `Документы обработаны моделью${result.model ? ` ${result.model}` : ''}. Проверьте выводы и подтверждающие цитаты перед принятием решений.`}</p></div></div>
    <div className="analysis-tabs" role="group" aria-label="Раздел результатов сравнения"><button aria-pressed={tab === 'findings'} aria-controls="analysis-content" onClick={() => { setTab('findings'); setFindingFilter('all'); focusContent(); }}><FileText size={17} />Выводы <span>{result.findings.length}</span></button><button aria-pressed={tab === 'functions'} aria-controls="analysis-content" onClick={() => { setTab('functions'); focusContent(); }}><GitCompareArrows size={17} />Функции <span>{result.function_changes.length}</span></button><button aria-pressed={tab === 'units'} aria-controls="analysis-content" onClick={() => { setTab('units'); focusContent(); }}><BookOpen size={17} />Подразделения <span>{result.unit_changes.length}</span></button><button aria-pressed={tab === 'repetitions'} aria-controls="analysis-content" onClick={showRepetitions}><FileText size={17} />Повторы текста <span>{sourcesPending ? '…' : unavailableSides.length ? '—' : repetitions.length}</span></button></div>
    <div className="analysis-stats" aria-label="Сводка замечаний">{(Object.keys(findingLabels) as (keyof typeof findingLabels)[]).map((kind) => <button type="button" className={`panel analysis-stat stat-${kind}`} aria-pressed={tab === 'findings' && findingFilter === kind} onClick={() => showFindingKind(kind)} key={kind}><span>{findingLabels[kind]}</span><strong>{result.findings.filter((finding) => finding.kind === kind).length}</strong></button>)}<button type="button" className="panel analysis-stat stat-repetitions" aria-pressed={tab === 'repetitions'} onClick={showRepetitions}><span>Повторы текста «после»</span><strong>{sourcesPending ? '…' : unavailableSides.includes('after') ? '—' : afterRepetitions.length}</strong></button></div>
    <div className="panel analysis-summary"><p>{result.summary}</p><div className="analysis-summary-meta"><span>{comparison.documents.length} документов</span><span>{result.functions.filter((item) => item.side === 'before').length} функций до → {result.functions.filter((item) => item.side === 'after').length} после</span><span>{new Date(result.generated_at).toLocaleString('ru-RU')}</span></div><div className="analysis-coverage">{(['before', 'after'] as const).map((side) => <span key={side} className={result.coverage[side] ? 'coverage-complete' : 'coverage-incomplete'}>{result.coverage[side] ? <Check size={14} /> : <AlertCircle size={14} />}{sideLabels[side]}: {result.coverage[side] ? 'полное покрытие' : 'неполное покрытие'}</span>)}</div>{(!result.coverage.before || !result.coverage.after) && <p className="analysis-coverage-note">При неполном наборе документов или неполном извлечении текста нельзя уверенно судить о потере функций.</p>}</div>
    {result.warnings.length > 0 && <details className="analysis-warnings"><summary><AlertCircle size={16} />Предупреждения анализа ({result.warnings.length})<ChevronDown size={15} /></summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    <div id="analysis-content" ref={content} tabIndex={-1} className="analysis-content" role="region" aria-label={tab === 'findings' ? 'Выводы сравнения' : tab === 'functions' ? 'Изменения функций' : tab === 'units' ? 'Изменения подразделений' : 'Повторы текста'}>
      {tab === 'findings' && findingFilter !== 'all' && <div className="analysis-filter-heading"><h3>{findingLabels[findingFilter]} <span>{visibleFindings.length}</span></h3><button type="button" className="text-button" onClick={() => setFindingFilter('all')}>Все выводы</button></div>}
      {tab === 'findings' && (visibleFindings.length ? visibleFindings.map((finding) => <FindingCard key={finding.id} finding={finding} review={reviews.get(finding.id)} comparison={comparison} onOpen={setSource} onRefresh={onRefresh} />) : <div className="panel analysis-empty"><CheckCheck size={28} /><h3>{findingFilter === 'all' ? 'Замечаний не найдено' : 'В этой категории нет замечаний'}</h3><p>{findingFilter === 'duplication' ? 'Здесь показаны возможные совпадения обязанностей у разных владельцев. Дословно повторённые пункты документа доступны в разделе «Повторы текста».' : 'Посмотрите сопоставление функций и подразделений. Отсутствие замечаний относится к загруженным документам и возможностям выбранного режима анализа.'}</p>{findingFilter === 'duplication' && <button type="button" className="button secondary" onClick={showRepetitions}>Показать повторы текста</button>}{result.mode === 'demo' && <p>В деморежиме смысловые совпадения и перефразированные функции могут быть пропущены.</p>}</div>)}
      {tab === 'repetitions' && <TextRepetitions groups={repetitions} loading={sourcesPending} unavailableSides={unavailableSides} onOpen={setSource} onRetry={onRefresh} />}
      {tab === 'functions' && (result.function_changes.length ? result.function_changes.map((change, index) => {
        const before = change.before_id ? functions.get(change.before_id) : undefined;
        return <article className="panel analysis-change" key={`${change.before_id ?? 'added'}-${index}`}><div className="analysis-card-top"><span className={`analysis-tag tag-${change.status}`}>{functionLabels[change.status]}</span><span className="analysis-change-number">{String(index + 1).padStart(2, '0')}</span></div><div className="analysis-mapping"><div><h3>До изменений</h3>{before ? <FunctionDetails item={before} /> : <p className="analysis-missing">Соответствие в документах «до» не найдено.</p>}</div><ArrowRight size={20} className="analysis-mapping-arrow" /><div><h3>После изменений</h3>{change.after_ids.length ? change.after_ids.map((id) => { const item = functions.get(id); return item ? <FunctionDetails key={id} item={item} /> : <p key={id} className="analysis-missing">Функция не найдена в результате.</p>; }) : <p className="analysis-missing">Соответствие в документах «после» не найдено.</p>}</div></div><p className="analysis-explanation">{change.explanation}</p><EvidenceList evidence={change.evidence} comparison={comparison} onOpen={setSource} /></article>;
      }) : <div className="panel analysis-empty"><GitCompareArrows size={28} /><h3>Нет сопоставлений функций</h3><p>Проверьте извлечённый текст и предупреждения анализа.</p></div>)}
      {tab === 'units' && (result.unit_changes.length ? result.unit_changes.map((change, index) => <article className="panel analysis-change" key={`${change.before_ids.join('-')}-${index}`}><div className="analysis-card-top"><span className={`analysis-tag tag-${change.status}`}>{unitLabels[change.status]}</span><span className="analysis-change-number">{String(index + 1).padStart(2, '0')}</span></div><div className="analysis-mapping"><div><h3>До изменений</h3>{change.before_ids.length ? change.before_ids.map((id) => <p className="analysis-unit-name" key={id}>{units.get(id)?.name ?? 'Подразделение не найдено в результате'}</p>) : <p className="analysis-missing">Соответствие в документах «до» не найдено.</p>}</div><ArrowRight size={20} className="analysis-mapping-arrow" /><div><h3>После изменений</h3>{change.after_ids.length ? change.after_ids.map((id) => <p className="analysis-unit-name" key={id}>{units.get(id)?.name ?? 'Подразделение не найдено в результате'}</p>) : <p className="analysis-missing">Соответствие в документах «после» не найдено.</p>}</div></div><p className="analysis-explanation">{change.explanation}</p><EvidenceList evidence={change.evidence} comparison={comparison} onOpen={setSource} /></article>) : <div className="panel analysis-empty"><BookOpen size={28} /><h3>Нет сопоставлений подразделений</h3><p>Проверьте, указаны ли названия подразделений в исходных документах.</p></div>)}
    </div>
    {source && <SourceDialog key={source.fragment_id} comparison={comparison} evidence={source} onClose={() => setSource(null)} />}
  </section>;
}
