import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowUpRight, Copy, FileText, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import type { Evidence } from './lib/types';
import type { TextRepetition } from './lib/textRepetitions';
import './text-repetitions.css';

interface Props {
  groups: TextRepetition[];
  loading: boolean;
  unavailableSides: ('before' | 'after')[];
  onOpen: (evidence: Evidence) => void;
  onRetry: () => Promise<void>;
}

const sideLabels = { before: 'До изменений', after: 'После изменений' };

function times(value: number) {
  return `${value.toLocaleString('ru-RU')} ${value % 10 >= 2 && value % 10 <= 4 && (value % 100 < 12 || value % 100 > 14) ? 'раза' : 'раз'}`;
}

function normalized(text: string) {
  return text.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function RepetitionCard({ group, onOpen }: { group: TextRepetition; onOpen: Props['onOpen'] }) {
  const section = group.occurrences[0]?.section?.trim();
  const commonSection = section && group.occurrences.every((occurrence) => occurrence.section?.trim() === section) ? section : undefined;
  const title = commonSection ? `Пункт ${commonSection} повторяется ${times(group.occurrences.length)}` : 'Повтор формулировки';
  return <article className="text-repetition-card panel">
    <div className="text-repetition-card-top"><span className="text-repetition-tag"><Copy size={14} />Повтор текста</span><span className="text-repetition-frequency">{times(group.occurrences.length)} в одном документе</span></div>
    <h3>{title}</h3>
    <p className="text-repetition-document"><FileText size={14} /><span>{sideLabels[group.side]} · {group.documentName}</span></p>
    <blockquote>{group.occurrences[0]?.text ?? group.text}</blockquote>
    <p className="text-repetition-description">Совпадает текст нескольких пунктов. Проверьте, нужен ли каждый повтор.</p>
    <div className="text-repetition-sources">
      <h4>Все места в документе <span>{group.occurrences.length.toLocaleString('ru-RU')}</span></h4>
      <ol>{group.occurrences.map((occurrence, index) => <li key={`${occurrence.fragmentId}-${index}`}>
        <button type="button" onClick={() => onOpen({ fragment_id: occurrence.fragmentId, quote: occurrence.text })} aria-label={`Открыть источник: ${occurrence.locator}${occurrence.section ? `, пункт ${occurrence.section}` : ''}`}>
          <span className="text-repetition-occurrence-number" aria-hidden="true">{index + 1}</span><span className="text-repetition-source-label"><strong>{occurrence.locator}</strong>{occurrence.section && <span>Пункт {occurrence.section}</span>}</span><ArrowUpRight size={16} />
        </button>
      </li>)}</ol>
    </div>
  </article>;
}

export default function TextRepetitions({ groups, loading, unavailableSides, onOpen, onRetry }: Props) {
  const [side, setSide] = useState<'before' | 'after'>('after');
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const mounted = useRef(true);
  const searchId = useId();
  const busy = loading || refreshing;
  const unavailable = unavailableSides.includes(side);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const counts = useMemo(() => ({ before: groups.filter((group) => group.side === 'before').length, after: groups.filter((group) => group.side === 'after').length }), [groups]);
  const selected = useMemo(() => groups.filter((group) => group.side === side), [groups, side]);
  const search = normalized(query);
  const filtered = useMemo(() => selected.filter((group) => !search || normalized([group.text, group.documentName, ...group.occurrences.flatMap((occurrence) => [occurrence.text, occurrence.locator, occurrence.section ?? ''])].join(' ')).includes(search)), [selected, search]);

  const refresh = async () => {
    if (busy) return;
    setRefreshing(true);
    setRefreshError(false);
    try {
      await onRetry();
    } catch {
      if (mounted.current) setRefreshError(true);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  };

  return <section className="text-repetitions" aria-label="Повторы формулировок">
    <div className="text-repetitions-heading"><div><h2>Повторы формулировок</h2><p>Одинаковый текст в нескольких местах одного документа.</p></div><button className="button secondary" type="button" disabled={busy} onClick={() => void refresh()}>{busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}Обновить текст документов</button></div>
    <p className="text-repetitions-note"><Copy size={17} /><span>Это проверка повторов формулировок. Вывод о дублировании полномочий требует проверки владельцев функций и контекста.</span></p>
    <div className="text-repetitions-tools">
      <div className="text-repetitions-sides" role="group" aria-label="Версия документов для поиска повторов">
        {(['before', 'after'] as const).map((value) => <button key={value} type="button" aria-pressed={side === value} onClick={() => setSide(value)}>{sideLabels[value]}<span aria-label={busy ? 'Загружается' : unavailableSides.includes(value) ? 'Часть текста не загружена' : `Групп повторов: ${counts[value]}`}>{busy ? '…' : unavailableSides.includes(value) ? '—' : counts[value].toLocaleString('ru-RU')}</span></button>)}
      </div>
      <div className="text-repetitions-search"><Search size={16} aria-hidden="true" /><label className="visually-hidden" htmlFor={searchId}>Поиск по тексту или номеру пункта</label><input id={searchId} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Текст или номер пункта" />{query && <button type="button" aria-label="Очистить поиск повторов" onClick={() => setQuery('')}><X size={15} /></button>}</div>
    </div>
    {refreshError && <div className="text-repetitions-error" role="alert"><AlertCircle size={17} /><p>Не удалось обновить текст документов. {groups.length ? 'Ниже показаны ранее загруженные данные. ' : ''}Повторите обновление.</p></div>}
    {!busy && unavailable && <div className="text-repetitions-error" role="alert"><AlertCircle size={17} /><p>Текст части документов этой версии не загружен. Список повторов может быть неполным. Повторите загрузку.</p></div>}
    {busy ? <div className="text-repetitions-state panel" role="status"><LoaderCircle className="spin" size={25} /><h3>Проверяем повторы текста</h3><p>Загружаем извлечённый текст документов и ищем одинаковые формулировки.</p></div> : filtered.length ? <>
      <p className="text-repetitions-result-count" role="status">{sideLabels[side]} · Групп повторов: {filtered.length.toLocaleString('ru-RU')}{search ? ` из ${selected.length.toLocaleString('ru-RU')}` : ''}</p>
      <div className="text-repetitions-list">{filtered.map((group) => <RepetitionCard key={group.id} group={group} onOpen={onOpen} />)}</div>
    </> : unavailable ? <div className="text-repetitions-state panel" role="status"><AlertCircle size={26} /><h3>Недостаточно текста для проверки</h3><p>Обновите текст документов, чтобы проверить повторы в версии «{side === 'after' ? 'после' : 'до'}».</p>{search && <button className="text-button" type="button" onClick={() => setQuery('')}>Сбросить поиск</button>}</div> : !refreshError && <div className="text-repetitions-state panel" role="status"><FileText size={26} /><h3>{selected.length && search ? 'По запросу ничего не найдено' : 'Повторов в загруженном тексте не найдено'}</h3><p>{selected.length && search ? 'Попробуйте другую формулировку или номер пункта.' : `Проверен доступный текст версии «${side === 'after' ? 'после' : 'до'}». Для проверки другого комплекта переключите версию.`}</p>{search && <button className="text-button" type="button" onClick={() => setQuery('')}>Сбросить поиск</button>}</div>}
  </section>;
}
