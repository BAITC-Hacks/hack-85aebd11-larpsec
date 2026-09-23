import { ArrowRight, CheckCheck, GitCompareArrows, LoaderCircle, Plus, Sparkles } from 'lucide-react';
import type { AnalysisResult, Comparison, Health, WorkspaceDocument } from './lib/types';
import './integration.css';

type Props = {
  comparison: Comparison | null;
  documents: WorkspaceDocument[];
  health: Health | null;
  result: AnalysisResult | null;
  disabled: boolean;
  loading: boolean;
  beforeComplete: boolean;
  afterComplete: boolean;
  setBeforeComplete: (value: boolean) => void;
  setAfterComplete: (value: boolean) => void;
  onAnalyze: () => void;
  onNew: () => void;
  onShow: () => void;
  onTextDiff: () => void;
  onSample: () => void;
};
const stages: Record<string, string> = {
  draft: 'Подготовка документов', queued: 'Ожидание обработки', extracting: 'Извлечение подразделений и функций',
  comparing: 'Сравнение комплектов', validating: 'Проверка выводов и источников', completed: 'Сравнение завершено', failed: 'Обработка прервана',
};

export function ComparisonControls(props: Props) {
  const { comparison, documents, health, result, disabled, loading } = props;
  const count = (side: 'before' | 'after') => documents.filter((doc) => doc.phase === side && doc.status === 'ready').length;
  const active = comparison?.status === 'queued' || comparison?.status === 'running';
  const frozen = active || comparison?.status === 'completed';
  const canAnalyze = count('before') > 0 && count('after') > 0 && documents.every((doc) => doc.status === 'ready') && health?.analysis_ready;
  const newDisabled = loading || documents.some((doc) => doc.status === 'uploading' || doc.status === 'processing');
  return <section className="comparison-controls panel" aria-label="Подготовка сравнения">
    <div className="comparison-control-heading"><div><span className="eyebrow">ДОКУМЕНТЫ → АНАЛИЗ → ИСТОЧНИКИ</span><h2><GitCompareArrows size={22} />{stages[comparison?.stage || 'draft'] || 'Анализ документов'}</h2></div><button className="text-button" disabled={newDisabled} onClick={props.onNew}><Plus size={16} />Новое сравнение</button></div>
    <div className="comparison-sets"><span><strong>{count('before')}</strong> до изменений</span><ArrowRight size={17} /><span><strong>{count('after')}</strong> после изменений</span>{result && <span className="comparison-saved"><CheckCheck size={16} />Результат сохранён</span>}</div>
    {!frozen && <>
      <fieldset className="coverage-fields" disabled={disabled}><legend>Полнота комплектов</legend><label><input type="checkbox" checked={props.beforeComplete} onChange={(event) => props.setBeforeComplete(event.target.checked)} />Все документы «до» загружены</label><label><input type="checkbox" checked={props.afterComplete} onChange={(event) => props.setAfterComplete(event.target.checked)} />Все документы «после» загружены</label></fieldset>
      <p className="comparison-hint">Отметьте полноту, только если загрузили весь комплект. Иначе отсутствие функции будет отмечено как недостаток данных.</p>
    </>}
    {active && <div className="analysis-progress" role="status"><LoaderCircle className="spin" size={18} /><span>{stages[comparison.stage] || 'Обработка'} · {comparison.progress}%</span><progress aria-label="Прогресс сравнения" max={100} value={comparison.progress} /></div>}
    {comparison?.error && <div className="inline-error" role="alert"><p>{comparison.error.message}</p></div>}
    <div className="comparison-actions">
      {count('before') > 0 && count('after') > 0 && <button className="button secondary" onClick={props.onTextDiff}><GitCompareArrows size={17} />Сравнить текст</button>}
      {result ? <button className="button primary" onClick={props.onShow}>Открыть результаты <ArrowRight size={17} /></button> : !active && <button className="button primary" disabled={disabled || !canAnalyze} onClick={props.onAnalyze}>{loading ? <LoaderCircle className="spin" size={17} /> : <GitCompareArrows size={17} />}{comparison?.status === 'failed' ? 'Повторить сравнение' : 'Запустить сравнение'}</button>}
      {!documents.length && !frozen && <button className="button secondary" disabled={disabled} onClick={props.onSample}><Sparkles size={17} />Загрузить пример «до/после»</button>}
      {health?.mode === 'demo' && <p className="comparison-hint">Демо: сервер сравнивает явные формулировки по правилам. Для смыслового ИИ-анализа подключите модель в настройках сервера.</p>}
      {health && !health.analysis_ready && <p className="comparison-hint">Сервер пока не готов к ИИ-анализу. Настройте модель на сервере и обновите подключение.</p>}
    </div>
  </section>;
}
