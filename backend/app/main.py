import hashlib
import logging
import re
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, FastAPI, File, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from app.analysis import Analyzer
from app.config import Settings
from app.errors import AppError
from app.jobs import Jobs
from app.models import (
    Comparison,
    CoverageUpdate,
    CreateComparison,
    Document,
    Fragment,
    Health,
    Result,
    Review,
    ReviewRecord,
    Side,
)
from app.parsing import SUPPORTED, parse_document
from app.report import report_markdown
from app.store import Store, now

logger = logging.getLogger(__name__)


class BodyLimitMiddleware:
    """Enforce a bound before multipart spooling, including chunked requests."""

    def __init__(self, app, limit: int):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers", []))
        try:
            length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            length = 0

        async def reject():
            response = JSONResponse(
                {
                    "error": {
                        "code": "upload_too_large",
                        "message": "Размер запроса превышает лимит загрузки.",
                    }
                },
                status_code=413,
            )
            await response(scope, receive, send)

        if length > self.limit:
            await reject()
            return
        size, messages = 0, []
        # Bound the complete body before a route can mutate state. Multipart parsers
        # may otherwise turn an exception raised inside receive into HTTP 400.
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            size += len(message.get("body", b""))
            if size > self.limit:
                await reject()
                return
            messages.append(message)
            if not message.get("more_body", False):
                break
        position = 0

        async def limited_receive():
            nonlocal position
            if position < len(messages):
                message = messages[position]
                position += 1
                return message
            return await receive()

        await self.app(scope, limited_receive, send)


def create_app(settings: Settings | None = None, analyzer: Analyzer | None = None) -> FastAPI:
    config = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.store = Store(config)
        app.state.jobs = Jobs(app.state.store, config, analyzer)
        try:
            yield
        finally:
            await run_in_threadpool(app.state.jobs.close)

    app = FastAPI(
        title="Larpsec — анализ организационных изменений",
        version="0.1.0",
        description="Комплекты до/после, функции, потенциальные отклонения и проверяемые источники.",
        lifespan=lifespan,
    )
    app.add_middleware(BodyLimitMiddleware, limit=(config.max_upload_mb + 1) * 1024**2)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_origins,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
        expose_headers=["Content-Disposition"],
        allow_credentials=False,
    )

    @app.exception_handler(AppError)
    async def app_error(request: Request, exc: AppError):
        return JSONResponse(
            {"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        return JSONResponse(
            {
                "error": {
                    "code": "validation_error",
                    "message": "Параметры запроса не соответствуют API.",
                    "fields": [".".join(map(str, e["loc"])) for e in exc.errors()],
                }
            },
            status_code=422,
        )

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception):
        logger.error(
            "Request failed method=%s exception_type=%s", request.method, type(exc).__name__
        )
        return JSONResponse(
            {"error": {"code": "internal_error", "message": "Внутренняя ошибка сервера."}},
            status_code=500,
        )

    bearer = HTTPBearer(auto_error=False)

    def authorize(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]):
        expected = config.api_token.get_secret_value()
        if expected and (
            credentials is None or not secrets.compare_digest(credentials.credentials, expected)
        ):
            raise AppError("unauthorized", "Требуется корректный Bearer-токен приложения.", 401)

    router = APIRouter(prefix="/api/v1", dependencies=[Depends(authorize)])

    @app.get("/health", response_model=Health, tags=["health"])
    def health():
        return Health(
            status="ok",
            mode=config.analysis_mode,
            analysis_ready=config.analysis_mode == "demo" or config.llm_ready,
            version="0.1.0",
        )

    @router.post("/comparisons", response_model=Comparison, status_code=201, tags=["comparisons"])
    def create_comparison(body: CreateComparison):
        return app.state.store.create(body)

    @router.get("/comparisons", response_model=list[Comparison], tags=["comparisons"])
    def list_comparisons(
        limit: Annotated[int, Query(ge=1, le=100)] = 20, offset: Annotated[int, Query(ge=0)] = 0
    ):
        return app.state.store.list(limit, offset)

    @router.get("/comparisons/{comparison_id}", response_model=Comparison, tags=["comparisons"])
    def get_comparison(comparison_id: str):
        return app.state.store.get(comparison_id)

    @router.patch(
        "/comparisons/{comparison_id}/coverage", response_model=Comparison, tags=["comparisons"]
    )
    def update_coverage(comparison_id: str, body: CoverageUpdate):
        return app.state.store.coverage(comparison_id, body.before_complete, body.after_complete)

    @router.post(
        "/comparisons/{comparison_id}/documents",
        response_model=Document,
        status_code=201,
        tags=["documents"],
    )
    def upload_document(
        comparison_id: str,
        side: Side,
        file: Annotated[UploadFile, File(description="Один DOCX, PDF, XLSX или TXT")],
    ):
        store = app.state.store
        comparison = store.get(comparison_id)
        if comparison.status not in {"draft", "failed"}:
            raise AppError(
                "comparison_locked",
                "Сравнение уже запущено. Создайте новое для изменения документов.",
                409,
            )
        filename = re.sub(
            r"[\x00-\x1f\x7f]", "", (file.filename or "document").replace("\\", "/").split("/")[-1]
        )[:200]
        suffix = Path(filename).suffix.lower()
        if suffix not in SUPPORTED:
            raise AppError("unsupported_format", "Поддерживаются DOCX, PDF, XLSX и TXT.", 415)
        document_id = uuid4().hex
        path = store.uploads / (document_id + suffix)
        digest, size = hashlib.sha256(), 0
        try:
            with path.open("xb") as target:
                while chunk := file.file.read(65536):
                    size += len(chunk)
                    if size > config.max_upload_mb * 1024**2:
                        raise AppError("upload_too_large", "Файл превышает допустимый размер.", 413)
                    digest.update(chunk)
                    target.write(chunk)
            parsed = parse_document(path, document_id, config)
            document = Document(
                id=document_id,
                comparison_id=comparison_id,
                side=side,
                filename=filename,
                format=suffix[1:],
                sha256=digest.hexdigest(),
                size_bytes=size,
                text_chars=sum(len(f.text) for f in parsed.fragments),
                fragment_count=len(parsed.fragments),
                warnings=parsed.warnings,
                extraction_complete=parsed.complete,
                created_at=now(),
            )
            return store.add_document(document, parsed.fragments, path)
        except Exception:
            path.unlink(missing_ok=True)
            raise
        finally:
            file.file.close()

    @router.get(
        "/comparisons/{comparison_id}/documents/{document_id}/fragments",
        response_model=list[Fragment],
        tags=["documents"],
    )
    def get_fragments(
        comparison_id: str,
        document_id: str,
        limit: Annotated[int, Query(ge=1, le=1000)] = 200,
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        return app.state.store.document(comparison_id, document_id)[1][offset : offset + limit]

    @router.get(
        "/comparisons/{comparison_id}/sources/{fragment_id}",
        response_model=Fragment,
        tags=["documents"],
    )
    def get_source(comparison_id: str, fragment_id: str):
        document_id = fragment_id.split(":", 1)[0]
        fragments = app.state.store.document(comparison_id, document_id)[1]
        for fragment in fragments:
            if fragment.id == fragment_id:
                return fragment
        raise AppError("not_found", "Исходный фрагмент не найден.", 404)

    @router.get("/comparisons/{comparison_id}/documents/{document_id}/download", tags=["documents"])
    def download_document(comparison_id: str, document_id: str):
        doc, _, path = app.state.store.document(comparison_id, document_id)
        if not path.is_file():
            raise AppError("file_missing", "Исходный файл отсутствует в хранилище.", 404)
        return FileResponse(path, filename=doc.filename, media_type="application/octet-stream")

    @router.delete(
        "/comparisons/{comparison_id}/documents/{document_id}", status_code=204, tags=["documents"]
    )
    def remove_document(comparison_id: str, document_id: str):
        app.state.store.delete_document(comparison_id, document_id)
        return Response(status_code=204)

    @router.post(
        "/comparisons/{comparison_id}/analyze",
        response_model=Comparison,
        status_code=202,
        tags=["analysis"],
    )
    def start_analysis(comparison_id: str):
        return app.state.jobs.start(comparison_id)

    @router.get("/comparisons/{comparison_id}/result", response_model=Result, tags=["analysis"])
    def get_result(comparison_id: str):
        return app.state.store.result(comparison_id)

    @router.patch(
        "/comparisons/{comparison_id}/findings/{finding_id}/review",
        response_model=ReviewRecord,
        tags=["analysis"],
    )
    def review_finding(comparison_id: str, finding_id: str, body: Review):
        return app.state.store.review(comparison_id, finding_id, body)

    @router.get("/comparisons/{comparison_id}/report", tags=["analysis"])
    def download_report(comparison_id: str, format: Literal["markdown", "json"] = "markdown"):
        store = app.state.store
        result = store.result(comparison_id)
        extension = "md" if format == "markdown" else "json"
        headers = {
            "Content-Disposition": f'attachment; filename="report-{comparison_id}.{extension}"'
        }
        if format == "json":
            return Response(
                result.model_dump_json(indent=2), media_type="application/json", headers=headers
            )
        return Response(
            report_markdown(store.get(comparison_id), result, store),
            media_type="text/markdown; charset=utf-8",
            headers=headers,
        )

    app.include_router(router)
    # Keep API, health and OpenAPI routes ahead of the frontend. StaticFiles serves
    # index.html only for directory URLs; unknown API/asset paths remain HTTP 404.
    frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if (frontend_dist / "index.html").is_file():
        app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
    return app


app = create_app()
