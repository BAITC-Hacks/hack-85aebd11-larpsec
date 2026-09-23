from __future__ import annotations

import json
import shutil
import sqlite3
import tempfile
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from app.config import Settings
from app.errors import AppError
from app.models import (
    Comparison,
    CreateComparison,
    Document,
    Fragment,
    Result,
    Review,
    ReviewRecord,
)


def now() -> str:
    return datetime.now(UTC).isoformat()


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.root = settings.data_dir.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.uploads = self.root / "uploads"
        self.uploads.mkdir(exist_ok=True)
        self.path = self.root / "analysis.sqlite3"
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS comparisons (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY, comparison_id TEXT NOT NULL REFERENCES comparisons(id),
                    payload TEXT NOT NULL, fragments TEXT NOT NULL, path TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS documents_comparison ON documents(comparison_id);
                CREATE TABLE IF NOT EXISTS results (
                    comparison_id TEXT PRIMARY KEY REFERENCES comparisons(id), payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS reviews (
                    comparison_id TEXT NOT NULL REFERENCES comparisons(id), finding_id TEXT NOT NULL,
                    payload TEXT NOT NULL, PRIMARY KEY (comparison_id, finding_id));
            """)

    @contextmanager
    def connect(self, write: bool = False):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def _load(self, db, comparison_id: str) -> dict:
        row = db.execute("SELECT payload FROM comparisons WHERE id=?", (comparison_id,)).fetchone()
        if row is None:
            raise AppError("not_found", "Сравнение не найдено.", 404)
        return json.loads(row[0])

    def _save(self, db, data: dict) -> None:
        data["updated_at"] = now()
        db.execute(
            "UPDATE comparisons SET payload=? WHERE id=?",
            (json.dumps(data, ensure_ascii=False), data["id"]),
        )

    def create(self, request: CreateComparison) -> Comparison:
        data = Comparison(
            id=uuid4().hex,
            **request.model_dump(),
            status="draft",
            stage="draft",
            progress=0,
            mode=None,
            error=None,
            created_at=now(),
            updated_at=now(),
            documents=[],
        )
        with self.connect(write=True) as db:
            db.execute("INSERT INTO comparisons VALUES (?,?)", (data.id, data.model_dump_json()))
        return data

    def get(self, comparison_id: str) -> Comparison:
        with self.connect() as db:
            data = self._load(db, comparison_id)
            data["documents"] = [
                json.loads(r[0])
                for r in db.execute(
                    "SELECT payload FROM documents WHERE comparison_id=? ORDER BY rowid",
                    (comparison_id,),
                )
            ]
        return Comparison.model_validate(data)

    def list(self, limit: int, offset: int) -> list[Comparison]:
        with self.connect() as db:
            ids = [
                r[0]
                for r in db.execute(
                    "SELECT id FROM comparisons ORDER BY rowid DESC LIMIT ? OFFSET ?",
                    (limit, offset),
                )
            ]
        comparisons = []
        for comparison_id in ids:
            try:
                comparisons.append(self.get(comparison_id))
            except AppError as error:
                # A concurrent deletion after the ID query must not break history.
                if error.status != 404 or error.code != "not_found":
                    raise
        return comparisons

    def _editable(self, data: dict) -> None:
        if data["status"] not in {"draft", "failed"}:
            raise AppError(
                "comparison_locked",
                "Сравнение уже запущено. Для изменения комплекта создайте новое.",
                409,
            )

    def _reset_failed_analysis(self, data: dict) -> None:
        if data["status"] == "failed":
            data.update(status="draft", stage="draft", progress=0, error=None, mode=None)

    def coverage(self, comparison_id: str, before: bool, after: bool) -> Comparison:
        with self.connect(write=True) as db:
            data = self._load(db, comparison_id)
            self._editable(data)
            data.update(before_complete=before, after_complete=after)
            self._save(db, data)
        return self.get(comparison_id)

    def add_document(self, document: Document, fragments: list[Fragment], path: Path) -> Document:
        with self.connect(write=True) as db:
            data = self._load(db, document.comparison_id)
            self._editable(data)
            previous = [
                Document.model_validate_json(r[0])
                for r in db.execute(
                    "SELECT payload FROM documents WHERE comparison_id=?", (document.comparison_id,)
                )
            ]
            if any(d.side == document.side and d.sha256 == document.sha256 for d in previous):
                raise AppError(
                    "duplicate_document", "Этот файл уже загружен в выбранный комплект.", 409
                )
            if len(previous) >= self.settings.max_documents:
                raise AppError("too_many_documents", "Достигнут лимит документов в сравнении.", 413)
            if (
                sum(d.text_chars for d in previous) + document.text_chars
                > self.settings.max_comparison_chars
            ):
                raise AppError(
                    "comparison_too_large", "Суммарный объём текста превышает лимит сравнения.", 413
                )
            db.execute(
                "INSERT INTO documents VALUES (?,?,?,?,?)",
                (
                    document.id,
                    document.comparison_id,
                    document.model_dump_json(),
                    json.dumps([f.model_dump() for f in fragments], ensure_ascii=False),
                    str(path),
                ),
            )
            self._reset_failed_analysis(data)
            self._save(db, data)
        return document

    def document(
        self, comparison_id: str, document_id: str
    ) -> tuple[Document, list[Fragment], Path]:
        with self.connect() as db:
            row = db.execute(
                "SELECT * FROM documents WHERE id=? AND comparison_id=?",
                (document_id, comparison_id),
            ).fetchone()
        if row is None:
            raise AppError("not_found", "Документ не найден в этом сравнении.", 404)
        return (
            Document.model_validate_json(row["payload"]),
            [Fragment.model_validate(x) for x in json.loads(row["fragments"])],
            Path(row["path"]),
        )

    def delete_document(self, comparison_id: str, document_id: str) -> None:
        with self.connect(write=True) as db:
            data = self._load(db, comparison_id)
            self._editable(data)
            row = db.execute(
                "SELECT path FROM documents WHERE id=? AND comparison_id=?",
                (document_id, comparison_id),
            ).fetchone()
            if row is None:
                raise AppError("not_found", "Документ не найден.", 404)
            db.execute("DELETE FROM documents WHERE id=?", (document_id,))
            self._reset_failed_analysis(data)
            self._save(db, data)
        Path(row[0]).unlink(missing_ok=True)

    def delete_comparison(self, comparison_id: str) -> None:
        """Serialize deletion with queueing and keep uploads recoverable until commit."""
        moved: list[tuple[Path, Path]] = []
        retired: Path | None = None
        try:
            with self.connect(write=True) as db:
                data = self._load(db, comparison_id)
                if data["status"] in {"queued", "running"}:
                    raise AppError(
                        "comparison_busy",
                        "Сравнение выполняется. Дождитесь завершения анализа перед удалением.",
                        409,
                    )
                paths = [
                    Path(row[0])
                    for row in db.execute(
                        "SELECT path FROM documents WHERE comparison_id=?", (comparison_id,)
                    )
                ]
                if paths:
                    retired = Path(tempfile.mkdtemp(prefix=".deleted-", dir=self.root))
                    for source in paths:
                        if source.exists():
                            destination = retired / source.name
                            source.rename(destination)
                            moved.append((source, destination))
                for table in ("reviews", "results", "documents"):
                    db.execute(f"DELETE FROM {table} WHERE comparison_id=?", (comparison_id,))
                db.execute("DELETE FROM comparisons WHERE id=?", (comparison_id,))
        except Exception:
            for source, destination in reversed(moved):
                destination.rename(source)
            if retired:
                retired.rmdir()
            raise
        if retired:
            shutil.rmtree(retired)

    def queue(self, comparison_id: str, mode: str) -> tuple[Comparison, bool]:
        with self.connect(write=True) as db:
            data = self._load(db, comparison_id)
            # Repeated requests are idempotent; a failed run may be explicitly retried.
            if data["status"] in {"queued", "running", "completed"}:
                return self.get(comparison_id), False
            docs = [
                json.loads(r[0])
                for r in db.execute(
                    "SELECT payload FROM documents WHERE comparison_id=?", (comparison_id,)
                )
            ]
            if {d["side"] for d in docs} != {"before", "after"}:
                raise AppError(
                    "missing_documents", "Загрузите хотя бы один документ в каждый комплект."
                )
            pending = sum(
                json.loads(r[0])["status"] in {"queued", "running"}
                for r in db.execute("SELECT payload FROM comparisons")
            )
            if pending >= self.settings.max_pending_jobs:
                raise AppError("queue_full", "Очередь заполнена. Повторите запрос позже.", 429)
            data.update(status="queued", stage="queued", progress=0, error=None, mode=mode)
            self._save(db, data)
        return self.get(comparison_id), True

    def progress(self, comparison_id: str, stage: str, progress: int) -> None:
        with self.connect(write=True) as db:
            data = self._load(db, comparison_id)
            data.update(status="running", stage=stage, progress=progress)
            self._save(db, data)

    def fail(self, comparison_id: str, code: str, message: str) -> None:
        with self.connect(write=True) as db:
            data = self._load(db, comparison_id)
            data.update(status="failed", stage="failed", error={"code": code, "message": message})
            self._save(db, data)

    def recover(self) -> None:
        with self.connect(write=True) as db:
            for row in db.execute("SELECT payload FROM comparisons").fetchall():
                data = json.loads(row[0])
                if data["status"] in {"queued", "running"}:
                    data.update(
                        status="failed",
                        stage="failed",
                        error={
                            "code": "interrupted",
                            "message": "Сервер перезапущен во время анализа. Запустите анализ повторно.",
                        },
                    )
                    self._save(db, data)

    def finish(self, result: Result) -> None:
        with self.connect(write=True) as db:
            db.execute(
                "INSERT OR REPLACE INTO results VALUES (?,?)",
                (result.comparison_id, result.model_dump_json()),
            )
            db.execute("DELETE FROM reviews WHERE comparison_id=?", (result.comparison_id,))
            data = self._load(db, result.comparison_id)
            data.update(status="completed", stage="completed", progress=100, error=None)
            self._save(db, data)

    def result(self, comparison_id: str) -> Result:
        with self.connect() as db:
            data = self._load(db, comparison_id)
            if data["status"] != "completed":
                raise AppError(
                    "result_not_ready", "Результат ещё не готов; проверьте статус сравнения.", 409
                )
            row = db.execute(
                "SELECT payload FROM results WHERE comparison_id=?", (comparison_id,)
            ).fetchone()
            result = Result.model_validate_json(row[0])
            result.reviews = [
                ReviewRecord.model_validate_json(r[0])
                for r in db.execute(
                    "SELECT payload FROM reviews WHERE comparison_id=? ORDER BY finding_id",
                    (comparison_id,),
                )
            ]
        return result

    def review(self, comparison_id: str, finding_id: str, review: Review) -> ReviewRecord:
        if not any(f.id == finding_id for f in self.result(comparison_id).findings):
            raise AppError("not_found", "Замечание не найдено.", 404)
        record = ReviewRecord(**review.model_dump(), finding_id=finding_id, updated_at=now())
        with self.connect(write=True) as db:
            self._load(db, comparison_id)
            db.execute(
                "INSERT OR REPLACE INTO reviews VALUES (?,?,?)",
                (comparison_id, finding_id, record.model_dump_json()),
            )
        return record
