import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError, createComparison, deleteDocument, getComparison, getDocumentResult, getHealth,
  getResult, setCoverage, startAnalysis, uploadDocument,
} from './lib/api';
import { validateDocumentSignature, validateFile } from './lib/documents';
import type { AnalysisResult, Comparison, DocumentPhase, Health, ServerDocument, WorkspaceDocument } from './lib/types';
import { comparisonTitle } from './lib/presentation';

export const COMPARISON_STORAGE_KEY = 'larpsec.comparisonId';
const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить запрос к серверу.';
const isLocked = (comparison: Comparison | null) => !!comparison && ['queued', 'running', 'completed'].includes(comparison.status);
function remember(id: string | null) {
  try { if (id) localStorage.setItem(COMPARISON_STORAGE_KEY, id); else localStorage.removeItem(COMPARISON_STORAGE_KEY); } catch { /* Private browsing can disable storage. */ }
}
function savedComparison() { try { return localStorage.getItem(COMPARISON_STORAGE_KEY); } catch { return null; } }
function restoredDocument(document: ServerDocument): WorkspaceDocument {
  return {
    id: document.id, serverId: document.id, file: new File([], document.filename), name: document.filename,
    sizeBytes: document.size_bytes, phase: document.side, source: 'server', status: 'processing',
    progress: 100, addedAt: Date.parse(document.created_at), extractionComplete: document.extraction_complete, uploadAttempted: true,
  };
}

export function useDocuments() {
  const [documents, setDocuments] = useState<WorkspaceDocument[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const documentsRef = useRef<WorkspaceDocument[]>([]);
  const comparisonRef = useRef<Comparison | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const cancelled = useRef(new Set<string>());
  const session = useRef(new AbortController());
  const generation = useRef(0);
  const creating = useRef<{ generation: number; promise: Promise<Comparison> } | null>(null);
  const analyzing = useRef(false);

  const changeDocuments = useCallback((change: (current: WorkspaceDocument[]) => WorkspaceDocument[]) => {
    documentsRef.current = change(documentsRef.current);
    setDocuments(documentsRef.current);
  }, []);
  const update = useCallback((id: string, patch: Partial<WorkspaceDocument>) => {
    const existing = documentsRef.current.find((document) => document.id === id);
    if (patch.phase && existing && patch.phase !== existing.phase && (existing.serverId || existing.uploadAttempted || isLocked(comparisonRef.current))) {
      setError('Версию документа после начала загрузки нельзя изменить. Удалите файл и добавьте его заново.');
      return;
    }
    changeDocuments((current) => current.map((document) => document.id === id ? { ...document, ...patch } : document));
  }, [changeDocuments]);
  const saveComparison = useCallback((value: Comparison | null) => {
    comparisonRef.current = value;
    setComparison(value);
    remember(value?.id || null);
  }, []);

  const syncComparison = useCallback(async (id: string, expectedGeneration: number, signal: AbortSignal) => {
    const next = await getComparison(id, signal);
    const analysis = next.status === 'completed' ? await getResult(id, signal) : null;
    if (generation.current !== expectedGeneration || signal.aborted) return;
    saveComparison(next);
    if (analysis) setResult(analysis);
    changeDocuments((current) => {
      const existing = new Map(current.filter((document) => document.serverId).map((document) => [document.serverId!, document]));
      const server = next.documents.flatMap((document) => {
        const known = existing.get(document.id);
        if (known) return [known];
        const pending = current.find((item) => !item.serverId && controllers.current.has(item.id) && item.phase === document.side && item.name === document.filename);
        return pending ? [] : [restoredDocument(document)];
      });
      return [...current.filter((document) => !document.serverId), ...server];
    });
    // A document is uploaded once; reading its source fragments can safely be retried.
    await Promise.all(next.documents.map(async (document) => {
      const local = documentsRef.current.find((item) => item.serverId === document.id);
      if (!local || local.result || controllers.current.has(local.id)) return;
      try {
        const extracted = await getDocumentResult(document, signal);
        if (generation.current === expectedGeneration && !signal.aborted) update(local.id, { status: 'ready', result: extracted, progress: 100, error: undefined });
      } catch (failure) {
        if (generation.current === expectedGeneration && !signal.aborted) update(local.id, { status: 'error', error: message(failure) });
      }
    }));
    if (generation.current === expectedGeneration && !signal.aborted) setError(next.status === 'failed' ? next.error?.message || 'Анализ завершился с ошибкой. Повторите запуск.' : '');
  }, [changeDocuments, saveComparison, update]);

  useEffect(() => {
    const controller = new AbortController();
    session.current = controller;
    const currentGeneration = ++generation.current;
    const restore = async () => {
      setLoading(true);
      const id = savedComparison();
      const healthRequest = getHealth(controller.signal).then((value) => {
        if (generation.current === currentGeneration) setHealth(value);
      }).catch(() => {
        if (generation.current === currentGeneration && !controller.signal.aborted) {
          setError((current) => current || 'Не удалось подключиться к серверу. Запустите сервер и нажмите «Повторить подключение».');
        }
      });
      try { if (id) await syncComparison(id, currentGeneration, controller.signal); }
      catch (failure) {
        if (!controller.signal.aborted && generation.current === currentGeneration) {
          if (failure instanceof ApiError && failure.status === 404) { remember(null); saveComparison(null); }
          setError(message(failure));
        }
      } finally {
        await healthRequest;
        if (generation.current === currentGeneration && !controller.signal.aborted) setLoading(false);
      }
    };
    void restore();
    return () => {
      generation.current++;
      controller.abort();
      controllers.current.forEach((active) => active.abort());
      controllers.current.clear();
    };
  }, [saveComparison, syncComparison]);

  // Continue polling through temporary network failures; reload restores the same server job.
  useEffect(() => {
    if (!comparison || !['queued', 'running'].includes(comparison.status)) return;
    const controller = new AbortController();
    const expectedGeneration = generation.current;
    const id = comparison.id;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await syncComparison(id, expectedGeneration, controller.signal); }
      catch (failure) {
        if (!controller.signal.aborted && generation.current === expectedGeneration) setError(`${message(failure)} Проверяем статус повторно…`);
      }
      if (!controller.signal.aborted && generation.current === expectedGeneration) timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 750);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [comparison?.id, comparison?.status, syncComparison]);

  const ensureComparison = async (expectedGeneration: number): Promise<Comparison> => {
    if (comparisonRef.current) return comparisonRef.current;
    if (creating.current?.generation === expectedGeneration) return creating.current.promise;
    const promise = createComparison(session.current.signal, comparisonTitle(documentsRef.current)).then((created) => {
      if (generation.current !== expectedGeneration) throw new DOMException('Операция отменена', 'AbortError');
      saveComparison(created);
      return created;
    });
    creating.current = { generation: expectedGeneration, promise };
    try { return await promise; }
    finally { if (creating.current?.promise === promise) creating.current = null; }
  };

  const add = async (file: File, phase: DocumentPhase, example = false): Promise<WorkspaceDocument> => {
    if (isLocked(comparisonRef.current) || analyzing.current) throw new Error('Создайте новое сравнение, чтобы изменить документы.');
    const expectedGeneration = generation.current;
    const validationError = validateFile(file);
    if (validationError) throw new Error(validationError);
    await validateDocumentSignature(file);
    if (generation.current !== expectedGeneration) throw new DOMException('Операция отменена', 'AbortError');
    const document: WorkspaceDocument = {
      id: crypto.randomUUID(), file, name: file.name, sizeBytes: file.size, phase,
      source: example ? 'example' : 'server', status: 'selected', progress: 0, addedAt: Date.now(),
    };
    changeDocuments((current) => [document, ...current]);
    setError('');
    return document;
  };

  const process = async (document: WorkspaceDocument): Promise<void> => {
    if (controllers.current.has(document.id)) return;
    if (isLocked(comparisonRef.current) || analyzing.current) {
      // Completed documents may still need their preview retried after a connection failure.
      if (!document.serverId) throw new Error('Создайте новое сравнение, чтобы загрузить документы.');
    }
    const expectedGeneration = generation.current;
    const controller = new AbortController();
    controllers.current.set(document.id, controller);
    cancelled.current.delete(document.id);
    const signal = AbortSignal.any([controller.signal, session.current.signal]);
    const active = () => generation.current === expectedGeneration && !signal.aborted;
    update(document.id, { status: document.serverId ? 'processing' : 'uploading', progress: 0, error: undefined, uploadAttempted: true });
    setError('');
    try {
      const target = await ensureComparison(expectedGeneration);
      void getHealth(signal).then((value) => { if (active()) setHealth(value); }).catch(() => {
        if (active()) setError('Документы доступны, но режим анализа не удалось определить. Нажмите «Повторить подключение».');
      });
      let metadata = target.documents.find((item) => item.id === document.serverId);
      if (!metadata) {
        // Recover a previous upload whose HTTP response was lost before retrying it.
        const bytes = await document.file.arrayBuffer();
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((value) => value.toString(16).padStart(2, '0')).join('');
        const latest = await getComparison(target.id, signal);
        if (!active()) return;
        if (isLocked(latest)) throw new Error('Анализ уже запущен. Создайте новое сравнение для изменения документов.');
        metadata = latest.documents.find((item) => item.side === document.phase && item.sha256 === digest);
        if (metadata && documentsRef.current.some((item) => item.id !== document.id && item.serverId === metadata!.id)) {
          throw new Error('Этот файл уже загружен для выбранной версии. Удалите повторный файл из списка.');
        }
        if (!metadata) metadata = await uploadDocument(target.id, document.file, document.phase, {
          signal,
          onProgress: (progress) => { if (active()) update(document.id, { progress }); },
          onProcessing: () => { if (active()) update(document.id, { status: 'processing' }); },
        });
      }
      if (!active()) return;
      update(document.id, { serverId: metadata.id, sizeBytes: metadata.size_bytes, extractionComplete: metadata.extraction_complete, status: 'processing' });
      saveComparison({ ...comparisonRef.current!, documents: [...comparisonRef.current!.documents.filter((item) => item.id !== metadata!.id), metadata] });
      const extracted = cancelled.current.has(document.id) ? undefined : await getDocumentResult(metadata, signal);
      if (!active()) return;
      if (cancelled.current.has(document.id)) {
        await deleteDocument(target.id, metadata.id);
        if (!active()) return;
        saveComparison({ ...comparisonRef.current!, documents: comparisonRef.current!.documents.filter((item) => item.id !== metadata!.id) });
        update(document.id, { status: 'selected', serverId: undefined, result: undefined, progress: 0, uploadAttempted: false });
      } else update(document.id, { status: 'ready', result: extracted, progress: 100, error: undefined });
      await syncComparison(target.id, expectedGeneration, signal);
    } catch (failure) {
      if (active()) update(document.id, { status: 'error', error: message(failure) });
    } finally {
      if (controllers.current.get(document.id) === controller) { controllers.current.delete(document.id); cancelled.current.delete(document.id); }
    }
  };

  const cancel = (id: string) => {
    if (controllers.current.has(id)) {
      // Wait for the upload acknowledgement, then remove it server-side as well.
      // Aborting an HTTP upload cannot guarantee that the server did not save the file.
      cancelled.current.add(id);
      update(id, { status: 'processing' });
    }
  };
  const remove = async (id: string): Promise<void> => {
    if (isLocked(comparisonRef.current) || analyzing.current) throw new Error('После запуска анализа документы нельзя удалять. Создайте новое сравнение.');
    if (controllers.current.has(id)) throw new Error('Дождитесь окончания загрузки или отмените её.');
    const document = documentsRef.current.find((item) => item.id === id);
    if (!document) return;
    const expectedGeneration = generation.current;
    const targetId = comparisonRef.current?.id;
    let serverId = document.serverId;
    if (!serverId && document.status === 'error' && targetId) {
      const latest = await getComparison(targetId, session.current.signal);
      const bytes = await document.file.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((value) => value.toString(16).padStart(2, '0')).join('');
      const stored = latest.documents.find((item) => item.side === document.phase && item.sha256 === digest);
      if (stored && !documentsRef.current.some((item) => item.id !== id && item.serverId === stored.id)) serverId = stored.id;
    }
    if (generation.current !== expectedGeneration) return;
    if (serverId && targetId) await deleteDocument(targetId, serverId);
    if (generation.current !== expectedGeneration) return;
    if (serverId && comparisonRef.current) saveComparison({ ...comparisonRef.current, documents: comparisonRef.current.documents.filter((item) => item.id !== serverId) });
    changeDocuments((current) => current.filter((item) => item.id !== id));
  };

  const analyze = async (beforeComplete: boolean, afterComplete: boolean): Promise<void> => {
    if (analyzing.current || isLocked(comparisonRef.current)) return;
    if (controllers.current.size || documentsRef.current.some((document) => document.status !== 'ready')) throw new Error('Сначала обработайте все выбранные документы или удалите лишние.');
    if (!['before', 'after'].every((side) => documentsRef.current.some((document) => document.phase === side && document.serverId))) throw new Error('Загрузите хотя бы один документ до и после реорганизации.');
    const expectedGeneration = generation.current;
    analyzing.current = true;
    setLoading(true);
    setError('');
    try {
      const target = await ensureComparison(expectedGeneration);
      await setCoverage(target.id, beforeComplete, afterComplete, session.current.signal);
      const next = await startAnalysis(target.id, session.current.signal);
      if (generation.current === expectedGeneration) { saveComparison(next); setResult(null); }
    } catch (failure) {
      if (generation.current === expectedGeneration && !session.current.signal.aborted) setError(message(failure));
      throw failure;
    } finally {
      if (generation.current === expectedGeneration) { analyzing.current = false; setLoading(false); }
    }
  };
  const refresh = async (): Promise<void> => {
    const expectedGeneration = generation.current;
    setLoading(true);
    try {
      const id = comparisonRef.current?.id || savedComparison();
      if (id) await syncComparison(id, expectedGeneration, session.current.signal);
      const nextHealth = await getHealth(session.current.signal);
      if (generation.current === expectedGeneration) {
        setHealth(nextHealth);
        setError(comparisonRef.current?.status === 'failed' ? comparisonRef.current.error?.message || 'Анализ завершился с ошибкой. Повторите запуск.' : '');
      }
    } catch (failure) {
      if (generation.current === expectedGeneration && !session.current.signal.aborted) setError(message(failure));
      throw failure;
    } finally { if (generation.current === expectedGeneration) setLoading(false); }
  };
  const newComparison = async (): Promise<void> => {
    generation.current++;
    session.current.abort();
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    cancelled.current.clear();
    session.current = new AbortController();
    creating.current = null;
    analyzing.current = false;
    changeDocuments(() => []);
    saveComparison(null);
    setResult(null);
    setError('');
    setLoading(false);
  };

  const openComparison = async (id: string): Promise<void> => {
    if (controllers.current.size || analyzing.current) throw new Error('Дождитесь завершения текущей операции.');
    const target = await getComparison(id, session.current.signal);
    await newComparison();
    const expectedGeneration = generation.current;
    saveComparison(target);
    setLoading(true);
    try { await syncComparison(id, expectedGeneration, session.current.signal); }
    catch (failure) { if (generation.current === expectedGeneration) setError(message(failure)); throw failure; }
    finally { if (generation.current === expectedGeneration) setLoading(false); }
  };

  return { documents, add, process, cancel, remove, update, comparison, result, health, loading, error, locked: isLocked(comparison), analyze, newComparison, openComparison, refresh };
}
