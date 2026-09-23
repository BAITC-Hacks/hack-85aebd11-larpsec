"""Regression cases from the QA report: extraction, matching and coverage."""

from io import BytesIO

import pytest
from docx import Document

from tests.conftest import analyze


def compare_lines(client, before, after):
    cid = client.post(
        "/api/v1/comparisons", json={"before_complete": True, "after_complete": True}
    ).json()["id"]
    for side, lines in [("before", before), ("after", after)]:
        doc = Document()
        for line in lines:
            doc.add_paragraph(line)
        stream = BytesIO()
        doc.save(stream)
        response = client.post(
            f"/api/v1/comparisons/{cid}/documents?side={side}",
            files={"file": (f"{side}.docx", stream.getvalue())},
        )
        assert response.status_code == 201, response.text
    return analyze(client, cid)


def test_qa01_numbered_unfamiliar_verbs_are_not_silently_lost(client):
    before = [
        "Подразделение: Бухгалтерия",
        "1.1. Проводит аудит.",
        "1.2. Составляет годовую отчётность.",
        "1.3. Начисляет заработную плату.",
        "1.4. Выполняет сверку расчётов.",
        "1.5. Консолидирует данные филиалов.",
        "1.6. Хранит первичные документы.",
        "4.1. Подписывает отчётность.",
    ]
    result = compare_lines(client, before, [line for line in before if not line.startswith("1.6.")])
    assert len([f for f in result["functions"] if f["side"] == "before"]) == 7
    assert result["coverage"] == {"before": True, "after": True}
    losses = [f for f in result["findings"] if f["kind"] == "potential_loss"]
    assert len(losses) == 1 and "Хранит первичные документы" in losses[0]["title"]


@pytest.mark.parametrize(
    "verb",
    [
        "Составляет",
        "Начисляет",
        "Выполняет",
        "Хранит",
        "Подписывает",
        "Оформляет",
        "Рассматривает",
        "Исполняет",
        "Определяет",
        "Устанавливает",
        "Информирует",
        "Регистрирует",
        "Учитывает",
        "Назначает",
        "Издаёт",
        "Выдаёт",
        "Консультирует",
        "Взаимодействует",
        "Рассчитывает",
    ],
)
def test_qa01_expanded_unnumbered_verbs(client, verb):
    lines = ["Подразделение: Бухгалтерия", f"{verb} документы."]
    result = compare_lines(client, lines, lines)
    assert len(result["functions"]) == 2
    assert all(result["coverage"].values())


def test_qa01_unrecognized_owner_block_prose_marks_incomplete(client):
    lines = ["Подразделение: Бухгалтерия", "1. Проводит аудит.", "Архивирует документы."]
    result = compare_lines(client, lines, lines)
    assert not any(result["coverage"].values())
    assert any("не распознано" in w and "Архивирует" in w for w in result["warnings"])


@pytest.mark.parametrize("marker", ["-", "–", "—", "•", "·", "*"])
def test_qa02_bulleted_function_is_extracted_without_marker(client, marker):
    lines = ["Подразделение: Кадры", f"{marker} Проводит аттестацию работников."]
    result = compare_lines(client, lines, lines)
    assert {f["action"] for f in result["functions"]} == {"Проводит аттестацию работников"}
    assert all(result["coverage"].values())


def test_qa02_function_before_first_owner_disables_complete_coverage(client):
    lines = ["1.1. Проводит общий аудит.", "Подразделение: Кадры", "1.2. Ведёт кадровый учёт."]
    result = compare_lines(client, lines, lines)
    assert not any(result["coverage"].values())
    assert any("владелец" in w and "Проводит общий аудит" in w for w in result["warnings"])


@pytest.mark.parametrize(
    "alias",
    [
        "Переименован из:",
        "Переименована из:",
        "Переименовано из:",
        "Переименованы из:",
        "Прежнее наименование:",
        "Ранее:",
    ],
)
def test_qa03_31_renamed_unit_keeps_its_functions(client, alias):
    result = compare_lines(
        client,
        ["Подразделение: Бухгалтерия", "1.1. Хранит первичные документы."],
        [
            "Подразделение: Управление бухгалтерского учёта",
            f"{alias} Бухгалтерия",
            "1.1. Хранит первичные документы.",
        ],
    )
    assert [c["status"] for c in result["unit_changes"]] == ["renamed"]
    assert [c["status"] for c in result["function_changes"]] == ["preserved"]
    assert not result["findings"]


def test_qa04_exact_owner_name_takes_precedence_over_another_unit_alias(client):
    result = compare_lines(
        client,
        ["Подразделение: Отдел А", "1.1. Проводит аудит."],
        [
            "Подразделение: Отдел Б",
            "Переименован из: Отдел А",
            "1.1. Проводит аудит.",
            "Подразделение: Отдел А",
            "1.2. Хранит документы.",
        ],
    )
    owners = {f["action"]: f["owner"] for f in result["functions"] if f["side"] == "after"}
    assert owners == {"Проводит аудит": "Отдел Б", "Хранит документы": "Отдел А"}
    assert {c["status"] for c in result["unit_changes"]} == {"renamed", "created"}


@pytest.mark.parametrize(
    "affirmative,negative",
    [
        ("Утверждает платежи поставщикам.", "Запрещено: утверждать платежи поставщикам."),
        ("Вправе: проводить инвентаризацию кассы.", "Запрещено: проводить инвентаризацию кассы."),
        ("Проводит инвентаризацию кассы.", "Не вправе: проводить инвентаризацию кассы."),
    ],
)
def test_qa05_conflicts_use_verb_inflection_and_rights(client, affirmative, negative):
    lines = ["Подразделение: Бухгалтерия", f"2.4. {affirmative}", f"2.5. {negative}"]
    result = compare_lines(client, lines, lines)
    conflicts = [f for f in result["findings"] if f["kind"] == "conflict"]
    assert len(conflicts) == 1 and len(conflicts[0]["function_ids"]) == 2


def test_qa05_different_scope_is_not_a_conflict(client):
    lines = [
        "Подразделение: Бухгалтерия",
        "1. Утверждает платежи; Область: филиалы.",
        "2. Запрещено: утверждать платежи; Область: головной офис.",
    ]
    assert not compare_lines(client, lines, lines)["findings"]


def test_qa06_reporting_change_includes_both_sources(client):
    before = [
        "Подразделение: Внутренний аудит",
        "Функциональное подчинение: Совет директоров",
        "Административное подчинение: Президент",
        "1.1. Проводит аудит.",
    ]
    after = [line.replace("Совет директоров", "Генеральный директор") for line in before]
    result = compare_lines(client, before, after)
    findings = [f for f in result["findings"] if f["kind"] == "reporting_change"]
    assert len(findings) == 1
    finding = findings[0]
    assert "Совет директоров → Генеральный директор" in finding["explanation"]
    assert len(finding["evidence"]) == 2 and "Внутренний аудит" in finding["title"]
    assert any("Совет директоров" in e["quote"] for e in finding["evidence"])
    assert any("Генеральный директор" in e["quote"] for e in finding["evidence"])


def test_qa06_renamed_subject_and_supervisor_do_not_fake_reporting_change(client):
    result = compare_lines(
        client,
        [
            "Подразделение: Аудит",
            "Функциональное подчинение: Руководитель",
            "1. Проводит аудит.",
            "Должность: Руководитель",
            "1. Утверждает отчёты.",
        ],
        [
            "Подразделение: Служба аудита",
            "Ранее: Аудит",
            "Функциональное подчинение: Директор",
            "1. Проводит аудит.",
            "Должность: Директор",
            "Ранее: Руководитель",
            "1. Утверждает отчёты.",
        ],
    )
    assert not result["findings"]


@pytest.mark.parametrize(
    "before_action,after_action,reason",
    [
        (
            "Проводит аудит; Область: филиалы.",
            "Проводит аудит; Область: филиалы и головной офис.",
            "область",
        ),
        ("Вправе: открывать счета.", "Не вправе: открывать счета.", "право → запрет"),
    ],
)
def test_qa07_changed_scope_or_kind_is_modified(client, before_action, after_action, reason):
    result = compare_lines(
        client,
        ["Подразделение: Бухгалтерия", f"1. {before_action}"],
        ["Подразделение: Бухгалтерия", f"1. {after_action}"],
    )
    assert len(result["function_changes"]) == 1
    change = result["function_changes"][0]
    assert change["status"] == "modified" and reason in change["explanation"]
    assert not result["findings"]


@pytest.mark.parametrize(
    "heading",
    [
        ["ПОЛОЖЕНИЕ об отделе кадров", "2. Функции отдела"],
        ["ПОЛОЖЕНИЕ", "об отделе кадров", "2. Функции отдела"],
        ["2. Функции отдела кадров"],
    ],
)
def test_qa08_standard_regulation_heading_without_magic_prefix(client, heading):
    lines = [*heading, "2.1. Ведёт кадровый учёт."]
    result = compare_lines(client, lines, lines)
    assert len(result["units"]) == 2 and len(result["functions"]) == 2
    assert result["function_changes"][0]["status"] == "preserved"


def test_qa08_unstructured_text_returns_result_and_explicit_warning(client):
    result = compare_lines(
        client,
        ["AI gonna kill us:", "1. Me", "2. All of us", "3. my cat.", "4. Last of us"],
        ["AI gonna kill us:", "1. me", "2. All of us", "3. My cat"],
    )
    assert not result["functions"] and not result["units"]
    assert not any(result["coverage"].values())
    assert result["findings"][0]["kind"] == "coverage_gap"
    assert "Структура функций не распознана" in result["findings"][0]["title"]


def test_qa08_generic_subject_rights_header_has_no_organizer_specific_names(client):
    lines = [
        "Координатор проекта имеет право:",
        "1. Запрашивать сведения.",
        "Сотрудники проекта не имеют права:",
        "2. Выдавать документы.",
    ]
    result = compare_lines(client, lines, lines)
    assert {u["name"] for u in result["units"]} == {"Координатор проекта", "Сотрудники проекта"}
    assert {f["kind"] for f in result["functions"]} == {"permission", "prohibition"}


def test_qa19_summary_describes_extracted_counts(client):
    lines = ["Подразделение: Кадры", "1. Ведёт кадровый учёт."]
    result = compare_lines(client, lines, lines)
    assert "Найдено подразделений и должностей: до — 1, после — 1" in result["summary"]
    assert "Сопоставлено подразделений" not in result["summary"]


def test_qa26_group_is_distinct_from_department(client):
    lines = ["Группа: Рабочая группа", "1. Готовит отчёт."]
    result = compare_lines(client, lines, lines)
    assert {u["kind"] for u in result["units"]} == {"group"}


def test_qa06_reporting_only_documents_still_compare_subjects(client):
    result = compare_lines(
        client,
        ["Подразделение: Аудит", "Функциональное подчинение: Совет"],
        ["Подразделение: Аудит", "Функциональное подчинение: Директор"],
    )
    assert [c["status"] for c in result["unit_changes"]] == ["preserved"]
    assert len([f for f in result["findings"] if f["kind"] == "reporting_change"]) == 1


def test_qa08_multiple_function_headings_switch_owners(client):
    lines = ["Функции отдела А", "1. Проводит аудит.", "Функции отдела Б", "2. Хранит документы."]
    result = compare_lines(client, lines, lines)
    assert {f["action"]: f["owner"] for f in result["functions"]} == {
        "Проводит аудит": "Отдел А",
        "Хранит документы": "Отдел Б",
    }


def test_qa08_heading_cases_do_not_create_a_second_owner(client):
    lines = ["ПОЛОЖЕНИЕ об отделе кадров", "2. Функции отдела кадров", "2.1. Ведёт кадровый учёт."]
    result = compare_lines(client, lines, lines)
    assert len(result["units"]) == 2
    assert {f["owner"] for f in result["functions"]} == {"Отдел кадров"}


@pytest.mark.parametrize("declared_side", ["before", "after"])
def test_qa06_same_supervisor_declared_as_unit_on_one_side_is_unchanged(client, declared_side):
    before = ["Подразделение: Аудит", "Функциональное подчинение: Директор", "1. Проводит аудит."]
    after = list(before)
    (before if declared_side == "before" else after).extend(
        ["Должность: Директор", "2. Подписывает отчёт."]
    )
    result = compare_lines(client, before, after)
    assert not any(f["kind"] == "reporting_change" for f in result["findings"])


def test_qa15_conflict_title_names_action_once(client):
    lines = [
        "Подразделение: Бухгалтерия",
        "1. Утверждает платежи поставщикам.",
        "2. Запрещено: утверждать платежи поставщикам.",
    ]
    result = compare_lines(client, lines, lines)
    conflict = next(f for f in result["findings"] if f["kind"] == "conflict")
    assert conflict["title"].count("платежи поставщикам") == 1
