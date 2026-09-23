import json

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.analysis import Analyzer, structure_changes, validate_plan
from app.demo import compare_demo, extract_demo
from app.errors import AppError
from app.evidence import covers
from app.llm import EXTRACT_PROMPT, ResponsesClient
from app.main import create_app
from app.models import AnalysisPlan, Evidence, Extraction, Fragment, Function, Unit, UnitLink
from tests.conftest import analyze, prepare


def configured(settings):
    settings.analysis_mode = "llm"
    settings.llm_api_key = SecretStr("test-only-not-a-real-key")
    settings.llm_model = "test-model"
    return settings


def output(value):
    return httpx.Response(
        200,
        json={
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "content": [
                        {"type": "output_text", "text": json.dumps(value, ensure_ascii=False)}
                    ],
                }
            ],
        },
    )


def test_real_adapter_and_full_llm_pipeline_with_mocked_provider(settings, demo_files):
    configured(settings)
    calls = []

    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        assert request.url.path == "/v1/responses"
        assert payload["store"] is False and payload["text"]["format"]["strict"] is True
        data = json.loads(payload["input"][0]["content"])
        if payload["text"]["format"]["name"] == "Extraction":
            value = extract_demo([Fragment.model_validate(f) for f in data["fragments"]])
        else:
            value = compare_demo(
                [Unit.model_validate(u) for u in data["units"]],
                [Function.model_validate(f) for f in data["functions"]],
            )
        return output(value.model_dump())

    engine = Analyzer(settings, ResponsesClient(settings, httpx.MockTransport(handler)))
    with TestClient(create_app(settings, engine)) as client:
        result = analyze(client, prepare(client, demo_files))
        assert result["mode"] == "llm" and result["model"] == "test-model"
        assert len(result["findings"]) == 3
    assert len(calls) == 3


@pytest.mark.parametrize(
    ("payload", "code"),
    [
        ({"status": "incomplete", "output": []}, "llm_incomplete"),
        (
            {
                "status": "completed",
                "output": [{"type": "message", "content": [{"type": "refusal", "refusal": "no"}]}],
            },
            "llm_refusal",
        ),
        (
            {
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": "invalid JSON"}],
                    }
                ],
            },
            "llm_invalid_output",
        ),
    ],
)
def test_invalid_model_responses(settings, payload, code):
    client = ResponsesClient(
        configured(settings), httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
    )
    with pytest.raises(AppError) as error:
        client.call(EXTRACT_PROMPT, {}, Extraction)
    assert error.value.code == code


def test_provider_auth_errors_do_not_expose_body(settings):
    client = ResponsesClient(
        configured(settings),
        httpx.MockTransport(lambda _: httpx.Response(401, text="private-secret-document")),
    )
    with pytest.raises(AppError) as error:
        client.call(EXTRACT_PROMPT, {}, Extraction)
    assert error.value.code == "llm_auth_error" and "private-secret" not in error.value.message


def test_timeout_is_distinct(settings):
    def timeout(request):
        raise httpx.ReadTimeout("timeout including secret context", request=request)

    client = ResponsesClient(configured(settings), httpx.MockTransport(timeout))
    with pytest.raises(AppError) as error:
        client.call(EXTRACT_PROMPT, {}, Extraction)
    assert error.value.code == "llm_timeout" and "secret" not in error.value.message


def test_fabricated_citation_fails_whole_analysis(settings, demo_files):
    def handler(request):
        data = json.loads(json.loads(request.content)["input"][0]["content"])
        value = extract_demo([Fragment.model_validate(f) for f in data["fragments"]])
        value.functions[0].evidence[0].quote = "This quote does not exist in the source."
        return output(value.model_dump())

    engine = Analyzer(configured(settings), ResponsesClient(settings, httpx.MockTransport(handler)))
    with TestClient(create_app(settings, engine)) as client:
        cid = prepare(client, demo_files)
        # Execute the engine synchronously to inspect the precise validation failure.
        store = client.app.state.store
        comparison = store.get(cid)
        with pytest.raises(AppError) as error:
            engine.run(
                comparison,
                {d.id: store.document(cid, d.id)[1] for d in comparison.documents},
                lambda *_: None,
            )
        assert error.value.code == "unsupported_evidence"
        assert client.get(f"/api/v1/comparisons/{cid}/result").status_code == 409


def test_unit_mergers_and_splits_use_link_graph():
    def unit(uid, side):
        return Unit(
            id=uid,
            side=side,
            name=uid,
            kind="department",
            aliases=[],
            evidence=[Evidence(fragment_id=uid, quote=uid)],
        )

    units = {
        uid: unit(uid, side)
        for uid, side in (("b1", "before"), ("b2", "before"), ("a1", "after"), ("a2", "after"))
    }

    def link(before, after):
        return UnitLink(
            before_id=before,
            after_id=after,
            reason="Передача функций",
            evidence=units[before].evidence + units[after].evidence,
        )

    merged = AnalysisPlan(
        unit_links=[link("b1", "a1"), link("b2", "a1")], function_links=[], issues=[], warnings=[]
    )
    assert "merged" in {c.status for c in structure_changes(merged, units)}
    split = AnalysisPlan(
        unit_links=[link("b1", "a1"), link("b1", "a2")], function_links=[], issues=[], warnings=[]
    )
    assert "split" in {c.status for c in structure_changes(split, units)}


def test_link_to_wrong_side_is_rejected():
    before = Unit(
        id="b1",
        side="before",
        name="Unit",
        kind="department",
        aliases=[],
        evidence=[Evidence(fragment_id="b", quote="Unit")],
    )
    plan = AnalysisPlan(
        unit_links=[
            UnitLink(before_id="b1", after_id="b1", reason="Invalid", evidence=before.evidence * 2)
        ],
        function_links=[],
        issues=[],
        warnings=[],
    )
    with pytest.raises(AppError) as error:
        validate_plan(
            plan,
            {"b1": before},
            {},
            {"b": Fragment(id="b", document_id="d", text="Unit", locator="p1")},
        )
    assert error.value.code == "invalid_analysis_reference"


def test_incomplete_extraction_overrides_user_coverage(settings, demo_files):
    configured(settings)

    def handler(request):
        payload = json.loads(request.content)
        data = json.loads(payload["input"][0]["content"])
        if payload["text"]["format"]["name"] == "Extraction":
            value = extract_demo([Fragment.model_validate(f) for f in data["fragments"]])
            value.complete = False
        else:
            value = compare_demo(
                [Unit.model_validate(u) for u in data["units"]],
                [Function.model_validate(f) for f in data["functions"]],
            )
        return output(value.model_dump())

    engine = Analyzer(settings, ResponsesClient(settings, httpx.MockTransport(handler)))
    with TestClient(create_app(settings, engine)) as client:
        result = analyze(client, prepare(client, demo_files))
        assert not any(result["coverage"].values())
        assert "potential_loss" not in {f["kind"] for f in result["findings"]}
        assert "coverage_gap" in {f["kind"] for f in result["findings"]}


def test_transient_provider_failure_is_retried(settings, monkeypatch):
    monkeypatch.setattr("app.llm.time.sleep", lambda _: None)
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(503)
        return output(
            {"units": [], "functions": [], "reporting": [], "warnings": [], "complete": True}
        )

    result = ResponsesClient(configured(settings), httpx.MockTransport(handler)).call(
        EXTRACT_PROMPT, {}, Extraction
    )
    assert result.functions == [] and len(calls) == 2


def test_citation_of_shared_heading_does_not_support_function_link():
    from app.models import FunctionLink

    fragments = {}
    functions = {}
    for side in ("before", "after"):
        header = Evidence(fragment_id=side + "_header", quote="Служба аудита")
        action = Evidence(fragment_id=side + "_action", quote="Проверяет сохранность активов.")
        for source in (header, action):
            fragments[source.fragment_id] = Fragment(
                id=source.fragment_id, document_id=side, text=source.quote, locator="пункт"
            )
        functions[side] = Function(
            id=side,
            side=side,
            unit_id=side,
            owner="Служба аудита",
            action="Проверяет сохранность активов",
            object="",
            scope="",
            kind="duty",
            evidence=[action, header],
        )
    plan = AnalysisPlan(
        unit_links=[],
        issues=[],
        warnings=[],
        function_links=[
            FunctionLink(
                before_id="before",
                after_ids=["after"],
                relation="equivalent",
                reason="Проверка",
                evidence=[functions[side].evidence[1] for side in ("before", "after")],
            )
        ],
    )
    with pytest.raises(AppError) as error:
        validate_plan(plan, {}, functions, fragments)
    assert error.value.code == "unsupported_mapping"
    plan.function_links[0].evidence = [functions[side].evidence[0] for side in ("before", "after")]
    validate_plan(plan, {}, functions, fragments)


def test_different_excerpt_in_same_paragraph_is_not_support():
    action = Evidence(fragment_id="one_paragraph", quote="Проверяет сохранность активов.")
    irrelevant = Evidence(fragment_id="one_paragraph", quote="Служба аудита")
    assert not covers([irrelevant], [action], primary_only=True)
