from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.errors import AppError
from app.main import create_app
from app.models import ReviewRecord
from app.report import FUNCTION_STATUSES, UNIT_STATUSES, report_markdown
from tests.conftest import analyze, prepare


def test_delete_completed_comparison_cascades_and_removes_uploads(client, demo_files):
    cid = prepare(client, demo_files)
    result = analyze(client, cid)
    store = client.app.state.store
    documents = store.get(cid).documents
    paths = [store.document(cid, document.id)[2] for document in documents]
    other = client.post("/api/v1/comparisons", json={}).json()["id"]
    assert (
        client.patch(
            f"/api/v1/comparisons/{cid}/findings/{result['findings'][0]['id']}/review",
            json={"status": "confirmed", "comment": "Проверено"},
        ).status_code
        == 200
    )
    response = client.delete(f"/api/v1/comparisons/{cid}")
    assert response.status_code == 204 and response.content == b""
    assert all(not path.exists() for path in paths)
    assert not list(store.root.glob(".deleted-*"))
    assert client.get(f"/api/v1/comparisons/{cid}").status_code == 404
    assert client.get(f"/api/v1/comparisons/{cid}/result").status_code == 404
    assert client.get(f"/api/v1/comparisons/{cid}/report?format=json").status_code == 404
    assert (
        client.get(f"/api/v1/comparisons/{cid}/sources/{documents[0].id}:00001").status_code == 404
    )
    assert client.delete(f"/api/v1/comparisons/{cid}").status_code == 404
    assert [item["id"] for item in client.get("/api/v1/comparisons").json()] == [other]
    with store.connect() as db:
        for table in ("documents", "results", "reviews"):
            assert (
                db.execute(
                    f"SELECT count(*) FROM {table} WHERE comparison_id=?", (cid,)
                ).fetchone()[0]
                == 0
            )


@pytest.mark.parametrize("status", ["draft", "failed"])
def test_delete_draft_and_failed_comparison(client, demo_files, status):
    cid = prepare(client, demo_files)
    if status == "failed":
        client.app.state.store.fail(cid, "test_failure", "Проверка")
    assert client.delete(f"/api/v1/comparisons/{cid}").status_code == 204
    assert not list(client.app.state.store.uploads.iterdir())


@pytest.mark.parametrize("status", ["queued", "running"])
def test_delete_active_comparison_rejected_without_mutation(client, demo_files, status):
    cid = prepare(client, demo_files)
    store = client.app.state.store
    store.queue(cid, "demo")
    if status == "running":
        store.progress(cid, "extracting", 20)
    response = client.delete(f"/api/v1/comparisons/{cid}")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "comparison_busy"
    assert store.get(cid).status == status
    assert len(list(store.uploads.iterdir())) == 2


def test_delete_and_queue_are_serialized(client, demo_files):
    cid = prepare(client, demo_files)
    store = client.app.state.store

    def queue():
        try:
            store.queue(cid, "demo")
            return "queued"
        except AppError as error:
            return error.code

    def delete():
        try:
            store.delete_comparison(cid)
            return "deleted"
        except AppError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as executor:
        queued = executor.submit(queue)
        deleted = executor.submit(delete)
        outcome = (queued.result(), deleted.result())
    assert outcome in {("queued", "comparison_busy"), ("not_found", "deleted")}


def test_history_skips_comparison_deleted_after_id_query(client, monkeypatch):
    kept = client.post("/api/v1/comparisons", json={"title": "Остаётся"}).json()["id"]
    removed = client.post("/api/v1/comparisons", json={"title": "Удаляется"}).json()["id"]
    store = client.app.state.store
    original_get = store.get

    def deleted_between_queries(comparison_id):
        if comparison_id == removed:
            store.delete_comparison(removed)
        return original_get(comparison_id)

    monkeypatch.setattr(store, "get", deleted_between_queries)
    response = client.get("/api/v1/comparisons")
    assert response.status_code == 200
    assert [comparison["id"] for comparison in response.json()] == [kept]


def test_history_does_not_hide_other_storage_errors(client, monkeypatch):
    client.post("/api/v1/comparisons", json={})
    store = client.app.state.store

    def unavailable(comparison_id):
        raise AppError("unavailable", "Хранилище недоступно.", 503)

    monkeypatch.setattr(store, "get", unavailable)
    response = client.get("/api/v1/comparisons")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "unavailable"


def test_delete_rolls_back_moved_files_if_filesystem_operation_fails(
    client, demo_files, monkeypatch
):
    cid = prepare(client, demo_files)
    store = client.app.state.store
    paths = [store.document(cid, document.id)[2] for document in store.get(cid).documents]
    rename = Path.rename

    def fail_second(source, target):
        if source == paths[1]:
            raise OSError("Cannot move file")
        return rename(source, target)

    monkeypatch.setattr(Path, "rename", fail_second)
    with pytest.raises(OSError, match="Cannot move file"):
        store.delete_comparison(cid)
    assert len(store.get(cid).documents) == 2
    assert all(path.is_file() for path in paths)
    assert not list(store.root.glob(".deleted-*"))


def test_markdown_is_russian_readable_and_preserves_quotes(client, demo_files):
    cid = prepare(client, demo_files)
    analyze(client, cid)
    store = client.app.state.store
    comparison = store.get(cid).model_copy(
        update={"title": "Отчёт \"Аудит\" <проверка> & 'контроль'"}
    )
    result = store.result(cid)
    result.generated_at = "2026-09-23T15:04:05+06:00"
    result.reviews = [
        ReviewRecord(
            finding_id=result.findings[0].id,
            status="confirmed",
            comment="Проверено \"по источнику\" и 'по пункту'",
            updated_at="2026-09-23T10:00:00+00:00",
        )
    ]
    for function in result.functions:
        function.object = ""
        function.scope = ""
    result.unit_changes = [
        result.unit_changes[0].model_copy(update={"status": status}) for status in UNIT_STATUSES
    ]
    result.function_changes = [
        result.function_changes[0].model_copy(update={"status": status})
        for status in FUNCTION_STATUSES
    ]
    report = report_markdown(comparison, result, store)
    assert "# Отчёт \"Аудит\" &lt;проверка&gt; &amp; 'контроль'" in report
    assert "23.09.2026 15:04:05 UTC+06:00" in report
    assert "Демонстрационный анализ" in report
    assert "До реорганизации: before.docx" in report
    assert "После реорганизации: after.docx" in report
    assert "Проверка сотрудником: Подтверждено" in report
    assert "Проверено \"по источнику\" и 'по пункту'" in report
    assert "Дата проверки: 23.09.2026 10:00:00 UTC+00:00" in report
    assert "&quot;" not in report and "&#x27;" not in report and "; ;" not in report
    assert "Область:" not in report and "Объект:" not in report
    for label in [*UNIT_STATUSES.values(), *FUNCTION_STATUSES.values()]:
        assert label in report
    for label in [*UNIT_STATUSES, *FUNCTION_STATUSES, "unreviewed", "confirmed", "demo;"]:
        assert label not in report


def test_json_export_is_self_contained_and_result_contract_stays_compact(client, demo_files):
    cid = prepare(client, demo_files)
    analyze(client, cid)
    response = client.get(f"/api/v1/comparisons/{cid}/report?format=json")
    assert response.status_code == 200
    data = response.json()
    assert data["export_version"] == 1 and data["comparison_id"] == cid
    assert data["comparison"]["title"] == "Учебная проверка"
    assert {document["filename"] for document in data["documents"]} == {"before.docx", "after.docx"}
    assert {document["side"] for document in data["documents"]} == {"before", "after"}
    documents = {document["id"]: document for document in data["documents"]}
    sources = {source["id"]: source for source in data["sources"]}
    assert len(sources) == sum(document["fragment_count"] for document in data["documents"])
    for section in (
        "units",
        "functions",
        "reporting",
        "unit_changes",
        "function_changes",
        "findings",
    ):
        for item in data[section]:
            for evidence in item["evidence"]:
                source = sources[evidence["fragment_id"]]
                assert evidence["quote"] in source["text"]
                assert evidence["sha256"] == documents[evidence["document_id"]]["sha256"]
                for field in (
                    "document_id",
                    "filename",
                    "side",
                    "sha256",
                    "locator",
                    "clause",
                    "page",
                    "sheet",
                    "cell_range",
                ):
                    assert evidence[field] == source[field]
    compact = client.get(f"/api/v1/comparisons/{cid}/result").json()
    assert "comparison" not in compact and "sources" not in compact
    assert set(compact["findings"][0]["evidence"][0]) == {"fragment_id", "quote"}
    schema = client.get("/openapi.json").json()
    responses = schema["paths"]["/api/v1/comparisons/{comparison_id}/report"]["get"]["responses"][
        "200"
    ]["content"]
    assert responses["application/json"]["schema"]["$ref"].endswith("/ReportExport")
    assert "text/markdown" in responses
    assert "delete" in schema["paths"]["/api/v1/comparisons/{comparison_id}"]


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_documentation_requires_configured_bearer_token(settings, path):
    settings.api_token = SecretStr("private-team-token")
    with TestClient(create_app(settings)) as client:
        assert client.get(path).status_code == 401
        assert client.get(path, headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert (
            client.get(path, headers={"Authorization": "Bearer private-team-token"}).status_code
            == 200
        )
        assert client.get("/health").status_code == 200


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_documentation_available_locally_without_token(client, path):
    assert client.get(path).status_code == 200


def test_hidden_docx_filename_uploads_normally(client, demo_files):
    cid = client.post("/api/v1/comparisons", json={}).json()["id"]
    with (demo_files / "before.docx").open("rb") as source:
        response = client.post(
            f"/api/v1/comparisons/{cid}/documents?side=before",
            files={"file": (".docx", source)},
        )
    assert response.status_code == 201, response.text
    assert response.json()["filename"] == ".docx"
    assert response.json()["format"] == "docx"
