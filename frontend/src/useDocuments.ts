import { useCallback, useEffect, useRef, useState } from 'react';
import { processOnServer, SERVER_MODE } from './lib/api';
import { readDocx } from './lib/local-reader';
import { validateDocxSignature, validateFile } from './lib/documents';
import type { DocumentPhase, WorkspaceDocument } from './lib/types';

export function useDocuments() {
  const [documents, setDocuments] = useState<WorkspaceDocument[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const active = controllers.current;
    return () => { active.forEach((controller) => controller.abort()); active.clear(); };
  }, []);

  const update = useCallback((id: string, patch: Partial<WorkspaceDocument>) => {
    setDocuments((current) => current.map((doc) => doc.id === id ? { ...doc, ...patch } : doc));
  }, []);

  const add = async (file: File, phase: DocumentPhase, example = false) => {
    const error = validateFile(file);
    if (error) throw new Error(error);
    await validateDocxSignature(file);
    const doc: WorkspaceDocument = {
      id: crypto.randomUUID(), file, name: file.name, phase, source: example ? 'example' : SERVER_MODE ? 'server' : 'local',
      status: 'selected', progress: 0, addedAt: Date.now(),
    };
    setDocuments((current) => [doc, ...current]);
    return doc;
  };

  const process = async (doc: WorkspaceDocument) => {
    if (controllers.current.has(doc.id)) return;
    const controller = new AbortController();
    controllers.current.set(doc.id, controller);
    const isServer = doc.source === 'server';
    update(doc.id, { status: isServer ? 'uploading' : 'processing', error: undefined, progress: 0 });
    try {
      const result = isServer
        ? await processOnServer(doc.file, doc.phase, {
          signal: controller.signal,
          onProgress: (progress) => update(doc.id, { progress }),
          onProcessing: () => update(doc.id, { status: 'processing' }),
        })
        : await readDocx(doc.file, controller.signal);
      if (!controller.signal.aborted) update(doc.id, { status: 'ready', result, progress: 100 });
    } catch (error) {
      if (!controller.signal.aborted) update(doc.id, { status: 'error', error: error instanceof Error ? error.message : 'Не удалось обработать документ.' });
    } finally {
      // An older cancelled request must not remove a newer retry's controller.
      if (controllers.current.get(doc.id) === controller) controllers.current.delete(doc.id);
    }
  };

  const cancel = (id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    update(id, { status: 'selected', progress: 0, error: undefined });
  };
  const remove = (id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    setDocuments((current) => current.filter((doc) => doc.id !== id));
  };

  return { documents, add, process, cancel, remove, update };
}
