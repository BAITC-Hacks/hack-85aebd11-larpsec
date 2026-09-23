import fcntl
import logging
from concurrent.futures import ThreadPoolExecutor

from app.analysis import Analyzer
from app.config import Settings
from app.errors import AppError
from app.store import Store

logger = logging.getLogger(__name__)


class Jobs:
    def __init__(self, store: Store, settings: Settings, analyzer: Analyzer | None = None):
        self.store = store
        self.settings = settings
        self.analyzer = analyzer or Analyzer(settings)
        # A single process owns the queue and restart recovery for this data directory.
        self.lock = (store.root / "worker.lock").open("a")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lock.close()
            raise RuntimeError(
                "DATA_DIR уже используется сервером. Запускайте один процесс uvicorn (--workers 1)."
            ) from None
        try:
            store.recover()
            self.pool = ThreadPoolExecutor(
                max_workers=settings.job_workers, thread_name_prefix="analysis"
            )
        except Exception:
            self.lock.close()
            raise

    def start(self, comparison_id: str):
        current = self.store.get(comparison_id)
        if current.status in {"queued", "running", "completed"}:
            return current
        if self.settings.analysis_mode == "llm" and not self.settings.llm_ready:
            raise AppError(
                "llm_not_configured",
                "Для анализа задайте LLM_API_KEY и LLM_MODEL в окружении сервера.",
                503,
            )
        comparison, queued = self.store.queue(comparison_id, self.settings.analysis_mode)
        if queued:
            try:
                self.pool.submit(self._run, comparison.id)
            except RuntimeError:
                self.store.fail(
                    comparison.id,
                    "shutdown",
                    "Сервер завершает работу. Повторите анализ после запуска.",
                )
                raise AppError("shutdown", "Сервер завершает работу.", 503) from None
        return comparison

    def _run(self, comparison_id: str):
        try:
            comparison = self.store.get(comparison_id)
            by_document = {
                d.id: self.store.document(comparison_id, d.id)[1] for d in comparison.documents
            }
            result = self.analyzer.run(
                comparison,
                by_document,
                lambda stage, value: self.store.progress(comparison_id, stage, value),
            )
            self.store.finish(result)
            logger.info("Analysis completed comparison_id=%s mode=%s", comparison_id, result.mode)
        except AppError as exc:
            self.store.fail(comparison_id, exc.code, exc.message)
            logger.warning("Analysis failed comparison_id=%s code=%s", comparison_id, exc.code)
        except Exception as exc:
            # Do not log exception messages/locals: provider/parser errors may contain source data.
            logger.error(
                "Analysis failed comparison_id=%s exception_type=%s",
                comparison_id,
                type(exc).__name__,
            )
            self.store.fail(
                comparison_id,
                "analysis_failed",
                "Внутренняя ошибка анализа. Повторите запрос или проверьте конфигурацию сервера.",
            )

    def close(self):
        self.pool.shutdown(wait=True, cancel_futures=False)
        fcntl.flock(self.lock, fcntl.LOCK_UN)
        self.lock.close()
