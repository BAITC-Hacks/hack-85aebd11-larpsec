import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, FileCheck2, FileText, Files, GitCompareArrows, Layers3, LoaderCircle, LockKeyhole, Plus, Search, ShieldCheck, Sparkles, Trash2, Upload, X, AlertCircle, BookOpen, List, PanelLeftClose } from 'lucide-react';
import { SERVER_MODE } from './lib/api';
import { DOCX_MIME, downloadText, formatBytes, plural } from './lib/documents';
import type { DocumentPhase, WorkspaceDocument } from './lib/types';
import { useDocuments } from './useDocuments';

const phaseLabels = { before: 'До изменений', after: 'После изменений' };
const statusLabels = { selected: 'Готов к загрузке', uploading: 'Отправляется', processing: 'Обрабатывается', ready: 'Текст извлечён', error: 'Ошибка обработки' };

function Brand({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'brand-small' : ''}`}><span className="brand-mark" aria-hidden="true"><i /><i /></span><span>larpsec<span className="brand-dot">.</span></span></div>;
}

function FileIcon({ small = false }: { small?: boolean }) {
  return <span className={`file-icon ${small ? 'small' : ''}`}><FileText aria-hidden="true" size={small ? 21 : 27} /><span>W</span></span>;
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
      <li><span>01</span><div><strong>Выберите DOCX</strong><p>Один файл размером до 20 МБ. Документы .doc и сканы нужно предварительно подготовить.</p></div></li>
      <li><span>02</span><div><strong>Укажите версию и запустите обработку</strong><p>Метка «до» или «после» поможет организовать документы для будущего сравнения.</p></div></li>
      <li><span>03</span><div><strong>Проверьте извлечённый текст</strong><p>Найдите нужный пункт, откройте фрагмент или скачайте текст. Форматирование и изображения Word в просмотр не входят.</p></div></li>
    </ol>
    <div className="notice"><ShieldCheck size={19} /><p>{SERVER_MODE ? 'Документы отправляются на подключённый сервер при нажатии кнопки обработки.' : 'В локальном режиме файл читается в вашем браузере и не отправляется на сервер.'} Список документов хранится только до обновления страницы.</p></div>
    <button className="button primary full-width" onClick={() => dialog.current?.close()}>Всё понятно <ArrowRight size={17} /></button>
  </dialog>;
}

function ResultView({ doc, onBack }: { doc: WorkspaceDocument; onBack: () => void }) {
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
    <div className="result-header"><div className="result-heading"><FileIcon /><div><h2 ref={resultHeading} tabIndex={-1}>{doc.name}</h2><p>{formatBytes(doc.file.size)}<span>·</span>{phaseLabels[doc.phase]}<span>·</span>DOCX</p></div></div><button className="button secondary" onClick={() => downloadText(doc.name, result.text)}><ArrowDownToLine size={16} />Скачать текст</button></div>
    <div className="success-banner" role="status"><span className="success-icon"><CheckCheck size={20} /></span><div><strong>Документ прочитан</strong><p>Извлечено {result.paragraphs.length} {plural(result.paragraphs.length, ['фрагмент', 'фрагмента', 'фрагментов'])}. Текст готов к просмотру.</p></div><span className="complete-badge">ГОТОВО</span></div>
    {doc.source === 'example' && <div className="notice example-notice"><Sparkles size={18} /><p>Это учебный документ для знакомства с интерфейсом. Он не является полной редакцией положения и не содержит результатов ИИ-анализа.</p></div>}
    {result.warnings.map((warning, i) => <div className="notice warning" key={i}><AlertCircle size={18} /><p>{warning}</p></div>)}
    <div className="reader-grid">
      <div className="reader panel">
        <div className="reader-toolbar"><div className="reader-tabs" role="group" aria-label="Вид документа"><button id="text-tab" aria-pressed={tab === 'text'} aria-controls="document-content" className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}><FileText size={16} />Текст</button><button id="sections-tab" aria-pressed={tab === 'sections'} aria-controls="document-content" className={tab === 'sections' ? 'active' : ''} onClick={() => setTab('sections')}><List size={17} />Пункты <span>{sections.length}</span></button></div><span className="reader-format">DOCX</span></div>
        <label className="reader-search"><Search size={17} /><input aria-label="Найти в документе" placeholder="Найти в документе…" value={query} onChange={(e) => setQuery(e.target.value)} />{query && <button className="icon-button" aria-label="Очистить поиск" onClick={() => setQuery('')}><X size={15} /></button>}</label>
        <div className="document-content" id="document-content" role="region" aria-label="Текст документа">
          {paragraphs.length ? paragraphs.map((p) => <article className="document-paragraph" key={p.id} id={`paragraph-${p.id}`}><span className="paragraph-number">{String(result.paragraphs.indexOf(p) + 1).padStart(2, '0')}</span><div>{p.section && <span className="section-tag">Пункт {p.section}</span>}<p>{p.text}</p></div></article>) : <div className="search-empty"><Search size={26} /><strong>{query ? 'Совпадений не найдено' : 'Нумерованных пунктов нет'}</strong><p>{query ? 'Попробуйте другое слово или номер пункта.' : 'Откройте вкладку «Текст», чтобы прочитать документ.'}</p></div>}
        </div>
        <div className="reader-footer"><ShieldCheck size={14} />Текст источника · без интерпретации</div>
      </div>
      <aside className="result-aside">
        <div className="panel document-summary"><span className="eyebrow">О ДОКУМЕНТЕ</span><h3>Всё на своём месте</h3><dl><div><dt>Фрагменты</dt><dd>{result.paragraphs.length}</dd></div><div><dt>Нумерованные пункты</dt><dd>{sections.length}</dd></div><div><dt>Символы</dt><dd>{result.text.length.toLocaleString('ru-RU')}</dd></div><div><dt>Версия</dt><dd>{phaseLabels[doc.phase]}</dd></div></dl></div>
        <div className="reading-note"><BookOpen size={21} /><h3>Сохраняем смысл источника</h3><p>Номера пунктов взяты из текста. Разбивка на фрагменты не соответствует страницам Word.</p><p>Таблицы отображаются как текст. Для проверки оформления используйте оригинал.</p></div>
        <div className="next-step"><span className="eyebrow">СЛЕДУЮЩИЙ ЭТАП</span><GitCompareArrows size={23} /><h3>Сравнение функций</h3><p>Поиск потерь, дублирования и пересечений появится после подключения анализа.</p><span className="coming-label">В разработке</span></div>
      </aside>
    </div>
  </section>;
}

export default function App() {
  const { documents, add, process, cancel, remove, update } = useDocuments();
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
  const busy = selected?.status === 'uploading' || selected?.status === 'processing';
  const completed = documents.filter((doc) => doc.status === 'ready').length;
  const filtered = documents.filter((doc) => doc.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')) && (filter === 'all' || doc.phase === filter));

  const accept = async (files: FileList | File[] | null) => {
    if (!files?.length || busy || accepting.current) return;
    setError('');
    if (files.length !== 1) { setError('Добавляйте по одному документу. Выберите один DOCX-файл.'); return; }
    accepting.current = true;
    setChoosing(true);
    try { const doc = await add(files[0], phase); setSelectedId(doc.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось открыть файл.'); }
    finally { setChoosing(false); accepting.current = false; if (input.current) input.current.value = ''; }
  };

  const example = async () => {
    if (busy || accepting.current) return;
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

  const newDocument = () => { setSelectedId(null); setError(''); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const selectDocument = (doc: WorkspaceDocument) => { setSelectedId(doc.id); setPhase(doc.phase); setError(''); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  return <div className="app-shell">
    <a className="skip-link" href="#main">Перейти к содержимому</a>
    <aside className="sidebar">
      <a href="#" className="brand-link" aria-label="Larpsec — документы" onClick={(e) => { e.preventDefault(); newDocument(); }}><Brand /></a>
      <div className="workspace-card"><span className="workspace-icon"><Layers3 size={19} /></span><div><strong>Рабочее пространство</strong><span>Команда Larpsec</span></div></div>
      <span className="nav-caption">ПРОЕКТ</span>
      <nav aria-label="Главная навигация"><button className="nav-item active" aria-label="Документы" onClick={newDocument}><Files size={19} /><span>Документы</span><span className="nav-count">{documents.length}</span></button><button className="nav-item" aria-label="Сравнение — скоро" disabled title="Сравнение будет доступно на следующем этапе"><GitCompareArrows size={19} /><span>Сравнение</span><span className="nav-soon">Скоро</span></button><button className="nav-item" aria-label="Заключения — скоро" disabled title="Заключения появятся после подключения анализа"><FileCheck2 size={19} /><span>Заключения</span></button></nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><div className="sidebar-orbit" aria-hidden="true"><span /><span /><span /><i /></div><span className="eyebrow">МЕНЬШЕ РУТИНЫ.</span><h3>Больше ясности<br />в вашей структуре.</h3><p>От отдельных документов<br />к целостной картине.</p></div><button className="help-button" onClick={() => setGuide(true)}><CircleHelp size={18} />Как это работает<ArrowUpRight size={16} /></button><div className="sidebar-user"><span className="avatar">L</span><div><strong>Команда Larpsec</strong><span>HackAlem AI</span></div><ShieldCheck size={17} /></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><PanelLeftClose size={18} /><span>Рабочее пространство</span><ChevronRight size={14} /><strong>Документы</strong></div><div className="topbar-right"><span className="event-tag">HACKALEM <span>AI</span></span><span className="header-divider" /><span className="avatar small-avatar">L</span></div></header>
      <main id="main">
        <div className="page-heading"><div><span className="eyebrow">АНАЛИЗ ОРГАНИЗАЦИОННОЙ СТРУКТУРЫ</span><h1>Документы<span className="heading-period">.</span></h1><p>Порядок в документах — первый шаг к ясной структуре.</p></div><span className="mode-label"><span className="mode-dot" />{SERVER_MODE ? 'Серверный режим' : 'Локальный просмотр'}</span></div>
        {selected?.status === 'ready' && selected.result ? <ResultView key={selected.id} doc={selected} onBack={newDocument} /> : <>
          <div className="upload-layout">
            <section className="upload-panel panel" aria-labelledby="upload-title">
              <div className="panel-heading"><div><span className="step-number">01</span><h2 id="upload-title">Загрузите документ</h2></div><span className="file-type-pill">.DOCX</span></div>
              <div className="version-row"><span>Версия документа</span><div className="segmented" role="group" aria-label="Версия документа">{(['before', 'after'] as const).map((value) => <button key={value} aria-pressed={phase === value} disabled={busy || choosing} className={phase === value ? 'selected' : ''} onClick={() => { setPhase(value); if (selected) update(selected.id, { phase: value }); }}>{phase === value && <span className="segment-dot" />}{phaseLabels[value]}</button>)}</div></div>
              <input ref={input} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="visually-hidden" aria-label="Выбрать DOCX-файл" tabIndex={-1} onChange={(e) => void accept(e.target.files)} />
              {!selected ? <div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragEnter={(e) => { e.preventDefault(); dragDepth.current++; setDragging(true); }} onDragLeave={(e) => { e.preventDefault(); dragDepth.current--; if (dragDepth.current === 0) setDragging(false); }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); setDragging(false); dragDepth.current = 0; void accept(e.dataTransfer.files); }}>
                <div className="upload-illustration" aria-hidden="true"><div className="paper paper-back" /><div className="paper paper-front"><span className="paper-w">W</span><i /><i /><i /></div><span className="upload-circle"><Upload size={19} /></span><span className="spark spark-one">+</span><span className="spark spark-two">+</span></div>
                <h3>{dragging ? 'Отпустите файл здесь' : 'Перетащите DOCX сюда'}</h3><p>Положение, инструкция или структура подразделения</p><button className="button primary" disabled={choosing} onClick={() => input.current?.click()}>{choosing ? <LoaderCircle size={17} className="spin" /> : <Plus size={18} />}Выбрать файл</button><span className="upload-limit">Один файл · до 20 МБ</span>
              </div> : <div className={`selected-file-area ${selected.status === 'error' ? 'has-error' : ''}`}>
                <div className="selected-file"><FileIcon /><div className="selected-file-name"><strong>{selected.name}</strong><span>{formatBytes(selected.file.size)} · DOCX {selected.source === 'example' && '· Учебный пример'}</span></div>{!busy && <button className="icon-button" aria-label="Убрать выбранный файл" onClick={() => { remove(selected.id); setSelectedId(null); setError(''); }}><X size={18} /></button>}</div>
                {busy ? <div className="processing-state" role="status"><span className="processing-symbol"><LoaderCircle className="spin" size={25} /></span><h3>{selected.status === 'uploading' ? 'Отправляем документ' : 'Читаем ваш документ'}</h3><p>{selected.status === 'uploading' ? 'Дождитесь завершения загрузки на сервер.' : 'Извлекаем текст и сохраняем номера пунктов.'}</p><div className={`progress-track ${selected.status === 'processing' ? 'indeterminate' : ''}`} role="progressbar" aria-label="Обработка документа" aria-valuemin={0} aria-valuemax={100} aria-valuenow={selected.status === 'uploading' ? selected.progress : undefined}><span style={selected.status === 'uploading' ? { width: `${selected.progress}%` } : undefined} /></div><button className="text-button" onClick={() => cancel(selected.id)}>Отменить</button></div> : <div className="file-ready"><span className="ready-check">{selected.status === 'error' ? <AlertCircle size={22} /> : <Check size={22} />}</span><h3>{selected.status === 'error' ? 'Не удалось прочитать документ' : 'Документ готов к обработке'}</h3><p>{selected.status === 'error' ? selected.error : selected.source === 'server' ? 'Отправим файл на сервер и покажем извлечённый текст.' : 'Прочитаем DOCX в браузере и покажем его содержимое.'}</p><button className="button primary" onClick={() => void process(selected)}>{selected.status === 'error' ? 'Повторить попытку' : 'Обработать документ'}<ArrowRight size={17} /></button><button className="text-button" onClick={() => input.current?.click()}>Выбрать другой файл</button></div>}
              </div>}
              {error && <div className="inline-error" role="alert"><AlertCircle size={18} /><p>{error}</p><button className="icon-button" aria-label="Скрыть ошибку" onClick={() => setError('')}><X size={16} /></button></div>}
              <div className="upload-panel-footer"><LockKeyhole size={15} /><span>{SERVER_MODE ? 'Файл отправляется только после запуска обработки' : 'Файл остаётся в вашем браузере'}</span><span className="footer-mini-label">{SERVER_MODE ? 'API' : 'ЛОКАЛЬНО'}</span></div>
            </section>
            <aside className="upload-aside"><section className="how-card"><div className="how-label"><span className="eyebrow">ПРОСТОЙ ПРОЦЕСС</span><Sparkles size={18} /></div><h2>Из документов —<br />в ясную картину.</h2><p className="how-intro">Начните с одного файла.<br />Остальное — шаг за шагом.</p><ol className="workflow"><li className="current"><span className="workflow-icon"><Upload size={17} /></span><div><strong>Загрузите DOCX</strong><p>Выберите документ и его версию</p></div></li><li><span className="workflow-icon"><FileText size={17} /></span><div><strong>Получите текст</strong><p>С исходными формулировками<br />и номерами пунктов</p></div></li><li><span className="workflow-icon"><CheckCheck size={17} /></span><div><strong>Проверьте результат</strong><p>Найдите нужное и сохраните текст</p></div></li></ol><div className="how-bottom"><span className="little-star">✳</span><span>Каждый вывод начинается<br />с надёжного источника.</span></div></section><button className="example-card" disabled={choosing || busy} onClick={() => void example()}><span className="example-icon"><BookOpen size={21} /></span><span><strong>Сначала посмотреть пример</strong><span>Учебный DOCX · без ваших данных</span></span><ArrowUpRight size={18} /></button></aside>
          </div>
          <div className="stage-strip"><div><span className="stage-icon"><Files size={18} /></span><span><strong>Документы</strong><small>Собираем исходные данные</small></span><span className="stage-current">СЕЙЧАС</span></div><ChevronRight size={17} /><div className="future-stage"><span className="stage-icon"><GitCompareArrows size={18} /></span><span><strong>Сравнение</strong><small>Находим изменения функций</small></span></div><ChevronRight size={17} /><div className="future-stage"><span className="stage-icon"><FileCheck2 size={18} /></span><span><strong>Заключение</strong><small>Выводы с подтверждениями</small></span></div></div>
        </>}
        <section className="library" aria-labelledby="library-title"><div className="library-heading"><div><h2 id="library-title">Документы сессии <span>{documents.length}</span></h2><p>{completed ? `${completed} ${plural(completed, ['документ обработан', 'документа обработано', 'документов обработано'])}` : 'Загруженные файлы появятся здесь'} · до обновления страницы</p></div>{documents.length > 0 && <button className="button secondary compact" onClick={newDocument}><Plus size={16} />Добавить документ</button>}</div>
          {documents.length > 0 ? <div className="panel document-list"><div className="library-tools"><label className="library-search"><Search size={16} /><input aria-label="Найти документ" placeholder="Поиск по названию…" value={query} onChange={(e) => setQuery(e.target.value)} /></label><label className="filter-control"><select aria-label="Фильтр по версии" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">Все версии</option><option value="before">До изменений</option><option value="after">После изменений</option></select><ChevronDown size={14} /></label></div><div className="table-scroll"><table><thead><tr><th>НАЗВАНИЕ ДОКУМЕНТА</th><th>ВЕРСИЯ</th><th>СТАТУС</th><th><span className="visually-hidden">Действия</span></th></tr></thead><tbody>{filtered.map((doc) => <tr key={doc.id}><td><button className="document-name" onClick={() => selectDocument(doc)}><FileIcon small /><span><strong>{doc.name}</strong><small>{formatBytes(doc.file.size)}{doc.source === 'example' ? ' · Учебный пример' : ''}</small></span></button></td><td><span className={`phase-tag phase-${doc.phase}`}>{phaseLabels[doc.phase]}</span></td><td><Status doc={doc} /></td><td><button className="icon-button delete-button" aria-label={`Удалить ${doc.name} из сессии`} onClick={() => { remove(doc.id); if (selectedId === doc.id) setSelectedId(null); }}><Trash2 size={16} /></button></td></tr>)}</tbody></table></div>{!filtered.length && <p className="list-empty">Документы не найдены. Измените поиск или фильтр.</p>}</div> : <div className="empty-library"><div className="empty-file-stack"><Files size={27} /></div><div><strong>Здесь пока чистый лист</strong><p>Загрузите первый документ или начните с учебного примера.</p></div><button className="text-button" disabled={choosing} onClick={() => void example()}>Открыть пример<ArrowRight size={16} /></button></div>}
        </section>
        <footer className="page-footer"><span>Larpsec <span> / </span> Осмысленные организационные изменения</span><span>Сделано для HackAlem AI <span className="footer-dot" /></span></footer>
      </main>
    </div>
    {guide && <Guide onClose={() => setGuide(false)} />}
  </div>;
}
