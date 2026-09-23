from collections import Counter
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.main import create_app
from app.store import Store
from tests.conftest import analyze, prepare, upload


def test_full_scenario_with_sources_and_reviews(client, demo_files):
    cid = prepare(client, demo_files)
    result = analyze(client, cid)
    assert result["mode"] == "demo" and result["model"] is None
    assert Counter(f["kind"] for f in result["findings"]) == {
        "potential_loss": 1,
        "duplication": 1,
        "conflict": 1,
    }
    assert "renamed" in {c["status"] for c in result["unit_changes"]}
    assert "created" in {c["status"] for c in result["unit_changes"]}
    assert "moved" in {c["status"] for c in result["function_changes"]}
    assert len(result["reporting"]) == 4
    functions = {f["id"]: f for f in result["functions"]}
    loss = next(f for f in result["findings"] if f["kind"] == "potential_loss")
    assert functions[loss["function_ids"][0]]["action"] == "Проверяет сохранность активов"
    moved = next(c for c in result["function_changes"] if c["status"] == "moved")
    assert (
        functions[moved["before_id"]]["action"] == "Готовит отчёт о результатах непрерывного аудита"
    )
    for finding in result["findings"]:
        assert finding["review_required"]
        for evidence in finding["evidence"]:
            source = client.get(f"/api/v1/comparisons/{cid}/sources/{evidence['fragment_id']}")
            assert source.status_code == 200
            assert evidence["quote"] in source.json()["text"]
    finding = result["findings"][0]
    response = client.patch(
        f"/api/v1/comparisons/{cid}/findings/{finding['id']}/review",
        json={"status": "confirmed", "comment": "Проверено по документам"},
    )
    assert response.status_code == 200
    assert (
        client.get(f"/api/v1/comparisons/{cid}/result").json()["reviews"][0]["status"]
        == "confirmed"
    )
    report = client.get(f"/api/v1/comparisons/{cid}/report")
    assert report.status_code == 200
    assert "before.docx" in report.text and "Источник" in report.text and "confirmed" in report.text
    assert (
        "Запрет — Департамент контроля качества аудита и методологии: утверждать платежи"
        in report.text
    )
    assert (
        "Обязанность — Департамент контроля качества аудита и методологии: Утверждать платежи"
        in report.text
    )
    assert (
        client.get(f"/api/v1/comparisons/{cid}/report?format=json").json()["comparison_id"] == cid
    )
    repeated = client.post(f"/api/v1/comparisons/{cid}/analyze")
    assert repeated.json()["status"] == "completed"
    assert (
        client.get(f"/api/v1/comparisons/{cid}/result").json()["generated_at"]
        == result["generated_at"]
    )
    assert upload(client, cid, demo_files / "before.docx", "before").status_code == 409


def test_identical_documents_have_no_findings(client, demo_files):
    cid = client.post(
        "/api/v1/comparisons", json={"before_complete": True, "after_complete": True}
    ).json()["id"]
    for side in ("before", "after"):
        assert upload(client, cid, demo_files / "before.docx", side).status_code == 201
    result = analyze(client, cid)
    assert not result["findings"]
    assert all(c["status"] == "preserved" for c in result["function_changes"])


def test_incomplete_input_never_asserts_loss(client, demo_files):
    result = analyze(client, prepare(client, demo_files, complete=False))
    kinds = Counter(f["kind"] for f in result["findings"])
    assert "potential_loss" not in kinds and kinds["coverage_gap"] == 1


def test_upload_validation_deletion_and_scope(client, demo_files):
    cid = client.post("/api/v1/comparisons", json={}).json()["id"]
    assert client.post(f"/api/v1/comparisons/{cid}/analyze").status_code == 422
    assert client.get(f"/api/v1/comparisons/{cid}/result").status_code == 409
    assert (
        client.post(
            f"/api/v1/comparisons/{cid}/documents?side=before", files={"file": ("a.exe", b"x")}
        ).status_code
        == 415
    )
    response = client.post(
        f"/api/v1/comparisons/{cid}/documents?side=before",
        files={"file": ("bad.docx", b"bad archive")},
    )
    assert response.status_code == 422 and response.json()["error"]["code"] == "invalid_document"
    doc = upload(client, cid, demo_files / "before.docx", "before").json()
    assert upload(client, cid, demo_files / "before.docx", "before").status_code == 409
    assert (
        client.get(f"/api/v1/comparisons/{cid}/documents/{doc['id']}/download").content
        == (demo_files / "before.docx").read_bytes()
    )
    assert (
        len(client.get(f"/api/v1/comparisons/{cid}/documents/{doc['id']}/fragments?limit=1").json())
        == 1
    )
    other = client.post("/api/v1/comparisons", json={}).json()["id"]
    assert client.get(f"/api/v1/comparisons/{other}/sources/{doc['id']}:00001").status_code == 404
    assert client.delete(f"/api/v1/comparisons/{cid}/documents/{doc['id']}").status_code == 204
    assert client.get(f"/api/v1/comparisons/{cid}").json()["documents"] == []


def test_persistence_and_restart(settings, demo_files):
    with TestClient(create_app(settings)) as first:
        cid = prepare(first, demo_files)
        result = analyze(first, cid)
    with TestClient(create_app(settings)) as second:
        assert second.get(f"/api/v1/comparisons/{cid}/result").json() == result
    store = Store(settings)
    from app.models import CreateComparison

    interrupted = store.create(CreateComparison())
    store.progress(interrupted.id, "extracting", 10)
    with TestClient(create_app(settings)) as third:
        state = third.get(f"/api/v1/comparisons/{interrupted.id}").json()
        assert state["status"] == "failed" and state["error"]["code"] == "interrupted"


def test_auth_and_cors(settings):
    settings.api_token = SecretStr("team-token")
    with TestClient(create_app(settings)) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/api/v1/comparisons").status_code == 401
        assert (
            client.get("/api/v1/comparisons", headers={"Authorization": "Bearer wrong"}).status_code
            == 401
        )
        assert (
            client.get(
                "/api/v1/comparisons", headers={"Authorization": "Bearer team-token"}
            ).status_code
            == 200
        )
        response = client.options(
            "/api/v1/comparisons",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Authorization",
            },
        )
        assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_missing_llm_config_returns_actionable_error(settings, demo_files):
    settings.analysis_mode = "llm"
    settings.llm_api_key = SecretStr("")
    settings.llm_model = ""
    with TestClient(create_app(settings)) as client:
        cid = prepare(client, demo_files)
        response = client.post(f"/api/v1/comparisons/{cid}/analyze")
        assert (
            response.status_code == 503 and response.json()["error"]["code"] == "llm_not_configured"
        )
        assert client.get("/health").json()["analysis_ready"] is False


def test_request_size_and_parameter_limits(settings):
    settings.max_upload_mb = 1
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/v1/comparisons", content=b"x" * (2 * 1024**2 + 1))
        assert response.status_code == 413
        assert client.get("/api/v1/comparisons?limit=1000").status_code == 422


def test_chunked_request_is_rejected_before_creating_state(settings):
    settings.max_upload_mb = 1
    with TestClient(create_app(settings)) as client:

        def chunks():
            yield b"x" * (1024**2)
            yield b"x" * (1024**2 + 1)

        response = client.post("/api/v1/comparisons", content=chunks())
        assert response.status_code == 413
        assert response.json()["error"]["code"] == "upload_too_large"
        assert client.get("/api/v1/comparisons").json() == []


def test_background_failure_is_visible_and_does_not_leak_source(settings, demo_files):
    class BrokenAnalyzer:
        def run(self, *args):
            raise RuntimeError("private-document-content")

    with TestClient(create_app(settings, BrokenAnalyzer())) as client:
        cid = prepare(client, demo_files)
        client.app.state.jobs._run(cid)
        state = client.get(f"/api/v1/comparisons/{cid}").json()
        assert state["status"] == "failed" and state["error"]["code"] == "analysis_failed"
        assert "private-document" not in str(state)


def test_second_worker_cannot_claim_same_database(settings):
    import pytest

    with TestClient(create_app(settings)):
        with pytest.raises(RuntimeError, match="DATA_DIR"):
            with TestClient(create_app(settings)):
                pass


def test_concurrent_starts_do_not_repeat_analysis(client, demo_files):
    cid = prepare(client, demo_files)
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(
            pool.map(lambda _: client.post(f"/api/v1/comparisons/{cid}/analyze"), range(4))
        )
    assert all(r.status_code == 202 for r in responses)
    result = analyze(client, cid)
    assert len(result["findings"]) == 3


def test_openapi_contract(client):
    schema = client.get("/openapi.json").json()
    assert (
        "multipart/form-data"
        in schema["paths"]["/api/v1/comparisons/{comparison_id}/documents"]["post"]["requestBody"][
            "content"
        ]
    )
    assert "HTTPBearer" in schema["components"]["securitySchemes"]
