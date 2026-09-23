"""Keep GitHub TXT support and local QA APIs together after the integration."""

import hashlib

import pytest

from tests.conftest import analyze


def upload_txt(client, comparison_id, side, filename, content):
    return client.post(
        f"/api/v1/comparisons/{comparison_id}/documents?side={side}",
        files={"file": (filename, content, "text/plain")},
    )


@pytest.mark.parametrize("filename", ["Положение.txt", "ПОЛОЖЕНИЕ.TXT", ".txt"])
def test_github_txt_upload_preserves_original_and_physical_source_lines(client, filename):
    comparison_id = client.post("/api/v1/comparisons", json={}).json()["id"]
    text = "\ufeffПодразделение: Аудит\r\n\r\n1.1. Проверяет отчётность.\r\n"
    content = text.encode("utf-8")
    response = upload_txt(client, comparison_id, "before", filename, content)
    assert response.status_code == 201, response.text
    document = response.json()
    assert document["filename"] == filename
    assert document["format"] == "txt"
    assert document["sha256"] == hashlib.sha256(content).hexdigest()
    assert document["size_bytes"] == len(content)
    assert document["extraction_complete"] is True
    fragments = client.get(
        f"/api/v1/comparisons/{comparison_id}/documents/{document['id']}/fragments"
    ).json()
    assert [fragment["text"] for fragment in fragments] == [
        "Подразделение: Аудит",
        "1.1. Проверяет отчётность.",
    ]
    assert [fragment["locator"] for fragment in fragments] == ["Строка 1", "Строка 3"]
    assert fragments[1]["clause"] == "1.1"
    assert (
        client.get(
            f"/api/v1/comparisons/{comparison_id}/documents/{document['id']}/download"
        ).content
        == content
    )


@pytest.mark.parametrize(
    "content",
    [
        b"%PDF-1.7\nA renamed PDF is not plain text",
        b" \nPK\x03\x04renamed-office-file",
        b"plain text\x00binary tail",
        b"\xff\xfeX",  # A declared but truncated UTF-16 file must not fall back to cp1251.
        "Подразделение: Аудит".encode() + b"\xd0",  # Truncated UTF-8 after a valid prefix.
    ],
)
def test_github_binary_or_damaged_txt_is_rejected_without_mutating_storage(client, content):
    comparison_id = client.post("/api/v1/comparisons", json={}).json()["id"]
    original = client.get(f"/api/v1/comparisons/{comparison_id}").json()
    response = upload_txt(client, comparison_id, "before", ".txt", content)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "invalid_document"
    assert client.get(f"/api/v1/comparisons/{comparison_id}").json() == original
    assert list(client.app.state.store.uploads.iterdir()) == []


def test_github_txt_keeps_qa_reporting_review_export_and_cascade_delete(client):
    comparison_id = client.post(
        "/api/v1/comparisons",
        json={
            "title": "Сравнение TXT после объединения",
            "before_complete": True,
            "after_complete": True,
        },
    ).json()["id"]
    before = (
        "Подразделение: Аудит\n"
        "Функциональное подчинение: Совет директоров\n"
        "1.1. Проводит проверки.\n"
        "1.2. Хранит документы.\n"
    )
    after = (
        "Подразделение: Аудит\n"
        "Функциональное подчинение: Генеральный директор\n"
        "1.1. Проводит проверки.\n"
    )
    for side, content in [("before", before), ("after", after)]:
        response = upload_txt(client, comparison_id, side, f"{side}.txt", content.encode("utf-8"))
        assert response.status_code == 201, response.text
    result = analyze(client, comparison_id)
    assert result["coverage"] == {"before": True, "after": True}
    assert {finding["kind"] for finding in result["findings"]} == {
        "reporting_change",
        "potential_loss",
    }
    reporting = next(
        finding for finding in result["findings"] if finding["kind"] == "reporting_change"
    )
    assert len(reporting["evidence"]) == 2 and reporting["function_ids"] == []
    review = client.patch(
        f"/api/v1/comparisons/{comparison_id}/findings/{reporting['id']}/review",
        json={"status": "confirmed", "comment": "Сверено с TXT"},
    )
    assert review.status_code == 200
    exported = client.get(f"/api/v1/comparisons/{comparison_id}/report?format=json").json()
    assert exported["export_version"] == 1
    assert exported["comparison"]["title"] == "Сравнение TXT после объединения"
    assert {document["format"] for document in exported["documents"]} == {"txt"}
    assert exported["reviews"][0]["status"] == "confirmed"
    sources = {source["id"]: source for source in exported["sources"]}
    for finding in exported["findings"]:
        for evidence in finding["evidence"]:
            assert evidence["quote"] in sources[evidence["fragment_id"]]["text"]
            assert evidence["locator"].startswith("Строка ")
            assert evidence["filename"].endswith(".txt")
            assert len(evidence["sha256"]) == 64
    markdown = client.get(f"/api/v1/comparisons/{comparison_id}/report").text
    assert "Изменение подчинения" in markdown and "Подтверждено" in markdown
    assert "До реорганизации: before.txt" in markdown and "Строка 2" in markdown
    assert client.delete(f"/api/v1/comparisons/{comparison_id}").status_code == 204
    assert client.get(f"/api/v1/comparisons/{comparison_id}/result").status_code == 404
    assert client.get("/api/v1/comparisons").json() == []
    assert list(client.app.state.store.uploads.iterdir()) == []


def test_github_openapi_has_txt_enum_and_local_qa_contract(client):
    schema = client.get("/openapi.json").json()
    models = schema["components"]["schemas"]
    assert set(models["Document"]["properties"]["format"]["enum"]) == {"docx", "pdf", "xlsx", "txt"}
    assert "reporting_change" in models["Finding"]["properties"]["kind"]["enum"]
    assert "reporting_change" in models["ExportFinding"]["properties"]["kind"]["enum"]
    comparison = schema["paths"]["/api/v1/comparisons/{comparison_id}"]
    assert "delete" in comparison and "204" in comparison["delete"]["responses"]
    report = schema["paths"]["/api/v1/comparisons/{comparison_id}/report"]["get"]
    assert report["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "/ReportExport"
    )
    assert {"comparison", "documents", "sources", "export_version"} <= set(
        models["ReportExport"]["properties"]
    )
