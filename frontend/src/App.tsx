import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, FileCheck2, FileText, Files, GitCompareArrows, Layers3, LoaderCircle, LockKeyhole, Plus, Search, ShieldCheck, Sparkles, Trash2, Upload, X, AlertCircle, BookOpen, List, PanelLeftClose } from 'lucide-react';
import ComparisonResults from './ComparisonResults';
import DocumentDiff from './DocumentDiff';
import { ConnectionSettings } from './ConnectionSettings';
import { ComparisonControls } from './ComparisonControls';
import { DOCX_MIME, downloadText, formatBytes, plural } from './lib/documents';
import type { DocumentPhase, WorkspaceDocument } from './lib/types';
import { useDocuments } from './useDocuments';

const phaseLabels = { before: 'До изменений', after: 'После изменений' };
const statusLabels = { selected: 'Готов к загрузке', uploading: 'Отправляется', processing: 'Обрабатывается', ready: 'Текст извлечён', error: 'Ошибка обработки' };

function Brand({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'brand-small' : ''}`}><span className="brand-mark" aria-hidden="true"><i /><i /></span><span>larpsec<span className="brand-dot">.</span></span></div>;
}

function FileIcon({ small = false, name = '' }: { small?: boolean; name?: string }) {
  return <span className={`file-icon ${small ? 'small' : ''}`}><FileText aria-hidden="true" size={small ? 21 : 27} /><span>{name.toLowerCase().endsWith('.pdf') ? 'P' : name.toLowerCase().endsWith('.xlsx') ? 'X' : 'W'}</span></span>;
}

function Status({ doc }: { doc: WorkspaceDocument }) {
  const busy = doc.status === 'processing' || doc.status === 'uploading';
  return <span className={`status status-${doc.status}`}>{busy ? <LoaderCircle size={13} className="spin" /> : doc.status === 'ready' ? <Check size={13} /> : doc.status === 'error' ? <AlertCircle size={13} /> : <span className="status-dot" />}{statusLabels[doc.status]}</span>;
}

function Guide({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="guide-dialog" onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) dialog.current?.close(); }}>
    <div className="dialog-head"><span className="eyebrow">КРАТКОЕ РУКОВОДСТВО</span><button className="icon-button" aria-label="Закрыть руководство" onClick={() => dialog.current?.close()}><X size={20} /></button></div>
    <h2>От документа<br />к понятной структуре.</h2>
    <p>Начните с положения о подразделении, должностной инструкции или другого организационного документа.</p>
    <ol className="guide-steps">
      <li><span>01</span><div><strong>Выберите документы до и после</strong><p>DOCX, PDF с текстовым слоем или XLSX. По одному файлу размером до 20 МБ. Для сканов нужно распознавание текста.</p></div></li>
      <li><span>02</span><div><strong>Укажите версию и запустите обработку</strong><p>Сервер сохранит документ, извлечёт текст и номера пунктов. Загрузите оба комплекта документов.</p></div></li>
      <li><span>03</span><div><strong>Сравните версии</strong><p>Откройте «Сравнить текст»: слева будет документ до изменений, справа — после. Удалённые строки выделены красным, добавленные — зелёным. Для анализа функций укажите полноту комплектов и нажмите «Запустить сравнение».</p></div></li>
    </ol>
    <div className="notice"><ShieldCheck size={19} /><p>Документы отправляются на сервер при обработке. Загруженные документы и результаты сохраняются; последнее сравнение открывается после обновления страницы. Выбранные, но не отправленные файлы нужно выбрать заново.</p></div>
    <button className="button primary full-width" onClick={() => dialog.current?.close()}>Всё понятно <ArrowRight size={17} /></button>
  </dialog>;
}

function ResultView({ doc, onBack, onCompare }: { doc: WorkspaceDocument; onBack: () => void; onCompare: () => void }) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'text' | 'sections'>('text');
  const resultHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    resultHeading.current?.focus({ preventScroll: true });
  }, []);
  const result = doc.result!;
  const sections = result.paragraphs.filter((p) => p.section);
  const paragraphs = (tab === 'sections' ? sections : result.paragraphs).filter((p) => p.text.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')));
  return <section className="result-view" aria-label="Результат обработки">
    <div className="result-navigation"><button className="text-button" onClick={onBack}><ArrowLeft size={17} />К загрузке документов</button><span className={`mode-label ${doc.source === 'example' ? 'example-label' : ''}`}>{doc.source === 'example' ? 'Учебный пример' : doc.source === 'local' ? 'Локальный просмотр' : 'Обработано на сервере'}</span></div>
    <div className="result-header"><div className="result-heading"><FileIcon name={doc.name} /><div><h2 ref={resultHeading} tabIndex={-1}>{doc.name}</h2><p>{formatBytes(doc.sizeBytes)}<span>·</span>{phaseLabels[doc.phase]}<span>·</span>{doc.name.split('.').pop()?.toUpperCase()}</p></div></div><button className="button secondary" onClick={() => downloadText(doc.name, result.text)}><ArrowDownToLine size={16} />Скачать текст</button></div>
    <div className="success-banner" role="status"><span className="success-icon"><CheckCheck size={20} /></span><div><strong>Документ прочитан</strong><p>Извлечено {result.paragraphs.length} {plural(result.paragraphs.length, ['фрагмент', 'фрагмента', 'фрагментов'])}. Текст готов к просмотру.</p></div><span className="complete-badge">ГОТОВО</span></div>
    {doc.source === 'example' && <div className="notice example-notice"><Sparkles size={18} /><p>Это учебный документ для знакомства с интерфейсом. Он не является полной редакцией положения и не содержит результатов ИИ-анализа.</p></div>}
    {result.warnings.map((warning, i) => <div className="notice warning" key={i}><AlertCircle size={18} /><p>{warning}</p></div>)}
    <div className="reader-grid">
      <div className="reader panel">
        <div className="reader-toolbar"><div className="reader-tabs" role="group" aria-label="Вид документа"><button id="text-tab" aria-pressed={tab === 'text'} aria-controls="document-content" className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}><FileText size={16} />Текст</button><button id="sections-tab" aria-pressed={tab === 'sections'} aria-controls="document-content" className={tab === 'sections' ? 'active' : ''} onClick={() => setTab('sections')}><List size={17} />Пункты <span>{sections.length}</span></button></div><span className="reader-format">{doc.name.split('.').pop()?.toUpperCase()}</span></div>
        <label className="reader-search"><Search size={17} /><input aria-label="Найти в документе" placeholder="Найти в документе…" value={query} onChange={(e) => setQuery(e.target.value)} />{query && <button className="icon-button" aria-label="Очистить поиск" onClick={() => setQuery('')}><X size={15} /></button>}</label>
        <div className="document-content" id="document-content" role="region" aria-label="Текст документа">
          {paragraphs.length ? paragraphs.map((p) => <article className="document-paragraph" key={p.id} id={`paragraph-${p.id}`}><span className="paragraph-number">{String(result.paragraphs.indexOf(p) + 1).padStart(2, '0')}</span><div>{p.section ? <span className="section-tag">Пункт {p.section}</span> : p.locator && <span className="section-tag">{p.locator}</span>}<p>{p.text}</p></div></article>) : <div className="search-empty"><Search size={26} /><strong>{query ? 'Совпадений не найдено' : 'Нумерованных пунктов нет'}</strong><p>{query ? 'Попробуйте другое слово или номер пункта.' : 'Откройте вкладку «Текст», чтобы прочитать документ.'}</p></div>}
        </div>
        <div className="reader-footer"><ShieldCheck size={14} />Текст источника · без интерпретации</div>
      </div>
      <aside className="result-aside">
        <div className="panel document-summary"><span className="eyebrow">О ДОКУМЕНТЕ</span><h3>Всё на своём месте</h3><dl><div><dt>Фрагменты</dt><dd>{result.paragraphs.length}</dd></div><div><dt>Нумерованные пункты</dt><dd>{sections.length}</dd></div><div><dt>Символы</dt><dd>{result.text.length.toLocaleString('ru-RU')}</dd></div><div><dt>Версия</dt><dd>{phaseLabels[doc.phase]}</dd></div></dl></div>
        <div className="reading-note"><BookOpen size={21} /><h3>Сохраняем смысл источника</h3><p>Фрагменты и адреса источников получены с сервера. Для PDF указаны страницы, для таблиц — листы и ячейки.</p><p>Таблицы отображаются как текст. Для проверки оформления используйте оригинал.</p></div>
        <div className="next-step"><span className="eyebrow">СЛЕДУЮЩИЙ ЭТАП</span><GitCompareArrows size={23} /><h3>Сравнение версий</h3><p>Откройте документы рядом, чтобы увидеть удалённые и добавленные строки. Затем можно перейти к анализу функций.</p><button className="text-button" onClick={onCompare}>К сравнению <ArrowRight size={16} /></button></div>
      </aside>
    </div>
  </section>;
}

export default function App() {
  const { documents, add, process, cancel, remove, update, comparison, result, health, loading, error: serverError, locked, analyze, newComparison, refresh } = useDocuments();
  const [view, setView] = useState<'documents' | 'comparison'>('documents');
  const [comparisonView, setComparisonView] = useState<'text' | 'analysis'>('text');
  const [working, setWorking] = useState(false);
  const [beforeComplete, setBeforeComplete] = useState(false);
  const [afterComplete, setAfterComplete] = useState(false);
  useEffect(() => {
    setBeforeComplete(comparison?.before_complete ?? false);
    setAfterComplete(comparison?.after_complete ?? false);
  }, [comparison?.id, comparison?.before_complete, comparison?.after_complete]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<DocumentPhase>('before');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [guide, setGuide] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const input = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const accepting = useRef(false);
  const selected = documents.find((doc) => doc.id === selectedId);
  const busy = documents.some((doc) => doc.status === 'uploading' || doc.status === 'processing');
  const unavailable = busy || choosing || working || loading || locked;
  const completed = documents.filter((doc) => doc.status === 'ready').length;
  const filtered = documents.filter((doc) => doc.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')) && (filter === 'all' || doc.phase === filter));

  const accept = async (files: FileList | File[] | null) => {
    if (!files?.length || unavailable || accepting.current) return;
    setError('');
    if (files.length !== 1) { setError('Добавляйте по одному документу. Выберите один DOCX, PDF или XLSX.'); return; }
    accepting.current = true;
    setChoosing(true);
    try { const doc = await add(files[0], phase); setSelectedId(doc.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось открыть файл.'); }
    finally { setChoosing(false); accepting.current = false; if (input.current) input.current.value = ''; }
  };

  const example = async () => {
    if (unavailable || accepting.current) return;
    accepting.current = true;
    setChoosing(true); setError('');
    try {
      const response = await fetch('/examples/audit-example.docx');
      if (!response.ok) throw new Error('Не удалось загрузить пример. Попробуйте ещё раз.');
      const file = new File([await response.blob()], 'Пример — положение о внутреннем аудите.docx', { type: DOCX_MIME });
      const doc = await add(file, phase, true);
      setSelectedId(doc.id);
      await process(doc);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось открыть пример.'); }
    finally { setChoosing(false); accepting.current = false; }
  };

  const newDocument = () => { setView('documents'); setSelectedId(null); setError(''); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const showTextComparison = () => { setComparisonView('text'); setView('comparison'); setSelectedId(null); };
  const showAnalysis = () => { setComparisonView('analysis'); setView('comparison'); setSelectedId(null); };
  const selectDocument = (doc: WorkspaceDocument) => { setView('documents'); setSelectedId(doc.id); setPhase(doc.phase); setError(''); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  const run = async (action: () => Promise<void>) => {
    setError(''); setWorking(true);
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось выполнить запрос. Повторите попытку.'); }
    finally { setWorking(false); }
  };
  const removeDocument = (id: string) => run(async () => { await remove(id); if (selectedId === id) setSelectedId(null); });
  const startNew = () => run(async () => { await newComparison(); setSelectedId(null); setView('documents'); setComparisonView('text'); setBeforeComplete(false); setAfterComplete(false); });
  const startAnalysis = () => run(async () => { await analyze(beforeComplete, afterComplete); showAnalysis(); });
  const samplePair = () => run(async () => {
    for (const side of ['before', 'after'] as const) {
      const response = await fetch(`/examples/${side}.docx`);
      if (!response.ok) throw new Error('Не удалось загрузить учебный комплект.');
      const doc = await add(new File([await response.blob()], `${side}.docx`, { type: DOCX_MIME }), side, true);
      await process(doc);
    }
    setBeforeComplete(true); setAfterComplete(true); showTextComparison();
  });

  return <div className="app-shell">
    <a className="skip-link" href="#main">Перейти к содержимому</a>
    <aside className="sidebar">
      <a href="#" className="brand-link" aria-label="Larpsec — документы" onClick={(e) => { e.preventDefault(); newDocument(); }}><Brand /></a>
      <div className="workspace-card"><span className="workspace-icon"><Layers3 size={19} /></span><div><strong>Рабочее пространство</strong><span>Команда Larpsec</span></div></div>
      <span className="nav-caption">ПРОЕКТ</span>
      <nav aria-label="Главная навигация"><button className={`nav-item ${view === 'documents' ? 'active' : ''}`} aria-label="Документы" onClick={newDocument}><Files size={19} /><span>Документы</span><span className="nav-count">{documents.length}</span></button><button className={`nav-item ${view === 'comparison' ? 'active' : ''}`} aria-label="Сравнение" onClick={() => { setView('comparison'); setSelectedId(null); }}><GitCompareArrows size={19} /><span>Сравнение</span>{result && <span className="nav-count">{result.findings.length}</span>}</button></nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><div className="sidebar-orbit" aria-hidden="true"><span /><span /><span /><i /></div><span className="eyebrow">МЕНЬШЕ РУТИНЫ.</span><h3>Больше ясности<br />в вашей структуре.</h3><p>От отдельных документов<br />к целостной картине.</p></div><button className="help-button" onClick={() => setGuide(true)}><CircleHelp size={18} />Как это работает<ArrowUpRight size={16} /></button><div className="sidebar-user"><span className="avatar">L</span><div><strong>Команда Larpsec</strong><span>HackAlem AI</span></div><ShieldCheck size={17} /></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><PanelLeftClose size={18} /><span>Рабочее пространство</span><ChevronRight size={14} /><strong>{view === 'comparison' ? 'Сравнение' : 'Документы'}</strong></div><div className="topbar-right"><span className="event-tag">HACKALEM <span>AI</span></span><span className="header-divider" /><span className="avatar small-avatar">L</span></div></header>
      <main id="main">
        <div className="page-heading"><div><span className="eyebrow">АНАЛИЗ ОРГАНИЗАЦИОННОЙ СТРУКТУРЫ</span><h1>{view === 'comparison' ? 'Сравнение' : 'Документы'}<span className="heading-period">.</span></h1><p>{view === 'comparison' && comparisonView === 'text' ? 'Две версии рядом. Каждое изменение на своём месте.' : 'Порядок в документах — первый шаг к ясной структуре.'}</p></div><span className="mode-label"><span className="mode-dot" />{view === 'comparison' && comparisonView === 'text' ? 'Сравнение текста' : health ? health.mode === 'demo' ? 'Демонстрационный анализ' : 'ИИ-анализ на сервере' : 'Подключение к серверу'}</span></div>
        {(error || serverError || (!health && !loading)) && <div className="inline-error integration-error" role="alert"><AlertCircle size={18} /><p>{error || serverError || 'Не удалось определить режим сервера. Повторите подключение.'}</p><button className="text-button" onClick={() => void run(refresh)}>Повторить подключение</button></div>}
        <ComparisonControls comparison={comparison} documents={documents} health={health} result={result} disabled={unavailable} loading={loading || working} beforeComplete={beforeComplete} afterComplete={afterComplete} setBeforeComplete={setBeforeComplete} setAfterComplete={setAfterComplete} onAnalyze={() => void startAnalysis()} onNew={() => void startNew()} onShow={showAnalysis} onTextDiff={showTextComparison} onSample={() => void samplePair()} />
        {view === 'comparison' ? <div className="comparison-workspace">
          <div className="comparison-view-tabs" role="group" aria-label="Режим сравнения">
            <button type="button" className={comparisonView === 'text' ? 'active' : ''} aria-pressed={comparisonView === 'text'} onClick={() => setComparisonView('text')}><FileText size={18} />Текст до / после</button>
            <button type="button" className={comparisonView === 'analysis' ? 'active' : ''} aria-pressed={comparisonView === 'analysis'} onClick={() => setComparisonView('analysis')}><GitCompareArrows size={18} />Анализ функций{result && <span>{result.findings.length}</span>}</button>
          </div>
          {comparisonView === 'text' ? <DocumentDiff key={comparison?.id || 'empty'} documents={documents} onDocuments={newDocument} /> : result && comparison ? <ComparisonResults comparison={comparison} result={result} onRefresh={refresh} /> : <section className="comparison-empty panel"><GitCompareArrows size={30} /><h2>{locked ? 'Сервер обрабатывает документы' : 'Анализ функций ещё не запущен'}</h2><p>{locked ? 'Статус обновляется автоматически. Можно обновить страницу — обработка продолжится на сервере.' : 'Загрузите документы обеих версий и запустите сравнение кнопкой выше. Подсветка изменений текста уже доступна в соседней вкладке.'}</p><button className="button secondary" onClick={newDocument}>К документам <ArrowRight size={16} /></button></section>}
        </div> : selected?.status === 'ready' && selected.result ? <ResultView key={selected.id} doc={selected} onBack={newDocument} onCompare={showTextComparison} /> : selected?.status === 'error' && selected.serverId ? <section className="comparison-empty panel"><h2>Не удалось загрузить текст</h2><p>{selected.error}</p><button className="button secondary" disabled={busy || working || loading} onClick={() => void run(() => process(selected))}>Повторить загрузку текста</button></section> : locked ? <div className="notice"><LockKeyhole size={18} /><p>Комплект зафиксирован для анализа. Документы доступны в списке ниже. Для загрузки других файлов создайте новое сравнение.</p></div> : <>
          <div className="upload-layout">
            <section className="upload-panel panel" aria-labelledby="upload-title">
              <div className="panel-heading"><div><span className="step-number">01</span><h2 id="upload-title">Загрузите документ</h2></div><span className="file-type-pill">DOCX · PDF · XLSX</span></div>
              <div className="version-row"><span>Версия документа</span><div className="segmented" role="group" aria-label="Версия документа">{(['before', 'after'] as const).map((value) => <button key={value} aria-pressed={phase === value} disabled={unavailable || Boolean(selected && (selected.serverId || selected.uploadAttempted || selected.status !== 'selected'))} className={phase === value ? 'selected' : ''} onClick={() => { setPhase(value); if (selected) update(selected.id, { phase: value }); }}>{phase === value && <span className="segment-dot" />}{phaseLabels[value]}</button>)}</div></div>
              <input ref={input} type="file" accept=".docx,.pdf,.xlsx" disabled={unavailable} className="visually-hidden" aria-label="Выбрать документ" tabIndex={-1} onChange={(e) => void accept(e.target.files)} />
              {!selected ? <div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragEnter={(e) => { e.preventDefault(); dragDepth.current++; setDragging(true); }} onDragLeave={(e) => { e.preventDefault(); dragDepth.current--; if (dragDepth.current === 0) setDragging(false); }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); setDragging(false); dragDepth.current = 0; void accept(e.dataTransfer.files); }}>
                <div className="upload-illustration" aria-hidden="true"><div className="paper paper-back" /><div className="paper paper-front"><span className="paper-w">W</span><i /><i /><i /></div><span className="upload-circle"><Upload size={19} /></span><span className="spark spark-one">+</span><span className="spark spark-two">+</span></div>
                <h3>{dragging ? 'Отпустите файл здесь' : 'Перетащите документ сюда'}</h3><p>Положение, инструкция или структура подразделения</p><button className="button primary" disabled={unavailable} onClick={() => input.current?.click()}>{choosing ? <LoaderCircle size={17} className="spin" /> : <Plus size={18} />}Выбрать файл</button><span className="upload-limit">Один файл · до 20 МБ</span>
              </div> : <div className={`selected-file-area ${selected.status === 'error' ? 'has-error' : ''}`}>
                <div className="selected-file"><FileIcon name={selected.name} /><div className="selected-file-name"><strong>{selected.name}</strong><span>{formatBytes(selected.sizeBytes)} · {selected.name.split('.').pop()?.toUpperCase()} {selected.source === 'example' && '· Учебный пример'}</span></div>{!unavailable && <button className="icon-button" aria-label="Убрать выбранный файл" onClick={() => void removeDocument(selected.id)}><X size={18} /></button>}</div>
                {busy ? <div className="processing-state" role="status"><span className="processing-symbol"><LoaderCircle className="spin" size={25} /></span><h3>{selected.status === 'uploading' ? 'Отправляем документ' : 'Читаем ваш документ'}</h3><p>{selected.status === 'uploading' ? 'Дождитесь завершения загрузки на сервер.' : 'Извлекаем текст и сохраняем номера пунктов.'}</p><div className={`progress-track ${selected.status === 'processing' ? 'indeterminate' : ''}`} role="progressbar" aria-label="Обработка документа" aria-valuemin={0} aria-valuemax={100} aria-valuenow={selected.status === 'uploading' ? selected.progress : undefined}><span style={selected.status === 'uploading' ? { width: `${selected.progress}%` } : undefined} /></div><button className="text-button" onClick={() => cancel(selected.id)}>Отменить</button></div> : <div className="file-ready"><span className="ready-check">{selected.status === 'error' ? <AlertCircle size={22} /> : <Check size={22} />}</span><h3>{selected.status === 'error' ? 'Не удалось прочитать документ' : 'Документ готов к обработке'}</h3><p>{selected.status === 'error' ? selected.error : 'Отправим файл на сервер и покажем извлечённый текст.'}</p><button className="button primary" disabled={unavailable} onClick={() => void run(() => process(selected))}>{selected.status === 'error' ? 'Повторить попытку' : 'Обработать документ'}<ArrowRight size={17} /></button><button className="text-button" disabled={unavailable} onClick={() => input.current?.click()}>Выбрать другой файл</button></div>}
              </div>}

              <div className="upload-panel-footer"><LockKeyhole size={15} /><span>Файл отправляется на сервер после запуска обработки</span><span className="footer-mini-label">СЕРВЕР</span></div>
            </section>
            <aside className="upload-aside"><section className="how-card"><div className="how-label"><span className="eyebrow">ПРОСТОЙ ПРОЦЕСС</span><Sparkles size={18} /></div><h2>Из документов —<br />в ясную картину.</h2><p className="how-intro">Начните с одного файла.<br />Остальное — шаг за шагом.</p><ol className="workflow"><li className="current"><span className="workflow-icon"><Upload size={17} /></span><div><strong>Загрузите документы</strong><p>Выберите документ и его версию</p></div></li><li><span className="workflow-icon"><FileText size={17} /></span><div><strong>Получите текст</strong><p>С исходными формулировками<br />и номерами пунктов</p></div></li><li><span className="workflow-icon"><CheckCheck size={17} /></span><div><strong>Проверьте результат</strong><p>Сравните версии и проверьте источники</p></div></li></ol><div className="how-bottom"><span className="little-star">✳</span><span>Каждый вывод начинается<br />с надёжного источника.</span></div></section><button className="example-card" disabled={unavailable} onClick={() => void example()}><span className="example-icon"><BookOpen size={21} /></span><span><strong>Сначала посмотреть пример</strong><span>Учебный DOCX · без ваших данных</span></span><ArrowUpRight size={18} /></button></aside>
          </div>
          <div className="stage-strip"><div><span className="stage-icon"><Files size={18} /></span><span><strong>Документы</strong><small>Собираем исходные данные</small></span><span className="stage-current">СЕЙЧАС</span></div><ChevronRight size={17} /><div className="available-stage"><span className="stage-icon"><GitCompareArrows size={18} /></span><span><strong>Сравнение</strong><small>Находим изменения функций</small></span></div><ChevronRight size={17} /><div className="available-stage"><span className="stage-icon"><FileCheck2 size={18} /></span><span><strong>Заключение</strong><small>Выводы с подтверждениями</small></span></div></div>
        </>}
        <section className="library" aria-labelledby="library-title"><div className="library-heading"><div><h2 id="library-title">Документы сравнения <span>{documents.length}</span></h2><p>{completed ? `${completed} ${plural(completed, ['документ обработан', 'документа обработано', 'документов обработано'])}` : 'Загруженные файлы появятся здесь'} · отправленные файлы сохранены на сервере</p></div>{documents.length > 0 && <button className="button secondary compact" disabled={unavailable} onClick={newDocument}><Plus size={16} />Добавить документ</button>}</div>
          {documents.length > 0 ? <div className="panel document-list"><div className="library-tools"><label className="library-search"><Search size={16} /><input aria-label="Найти документ" placeholder="Поиск по названию…" value={query} onChange={(e) => setQuery(e.target.value)} /></label><label className="filter-control"><select aria-label="Фильтр по версии" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">Все версии</option><option value="before">До изменений</option><option value="after">После изменений</option></select><ChevronDown size={14} /></label></div><div className="table-scroll"><table><thead><tr><th>НАЗВАНИЕ ДОКУМЕНТА</th><th>ВЕРСИЯ</th><th>СТАТУС</th><th><span className="visually-hidden">Действия</span></th></tr></thead><tbody>{filtered.map((doc) => <tr key={doc.id}><td><button className="document-name" onClick={() => selectDocument(doc)}><FileIcon small name={doc.name} /><span><strong>{doc.name}</strong><small>{formatBytes(doc.sizeBytes)}{doc.source === 'example' ? ' · Учебный пример' : ''}</small></span></button></td><td><span className={`phase-tag phase-${doc.phase}`}>{phaseLabels[doc.phase]}</span></td><td><Status doc={doc} /></td><td><button className="icon-button delete-button" disabled={unavailable} aria-label={`Удалить ${doc.name} из сравнения`} onClick={() => void removeDocument(doc.id)}><Trash2 size={16} /></button></td></tr>)}</tbody></table></div>{!filtered.length && <p className="list-empty">Документы не найдены. Измените поиск или фильтр.</p>}</div> : <div className="empty-library"><div className="empty-file-stack"><Files size={27} /></div><div><strong>Здесь пока чистый лист</strong><p>Загрузите первый документ или начните с учебного примера.</p></div><button className="text-button" disabled={unavailable} onClick={() => void example()}>Открыть пример<ArrowRight size={16} /></button></div>}
        </section>
        <ConnectionSettings onReconnect={refresh} disabled={busy || working || choosing || loading} />
        <footer className="page-footer"><span>Larpsec <span> / </span> Осмысленные организационные изменения</span><span>Сделано для HackAlem AI <span className="footer-dot" /></span></footer>
      </main>
    </div>
    {guide && <Guide onClose={() => setGuide(false)} />}
  </div>;
}
