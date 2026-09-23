"""Regression reproductions from QA_REPORT_2.md (Н1–Н9)."""

import pytest

from app.analysis import Analyzer
from app.errors import AppError
from app.parsing import decode_plain_text
from tests.test_qa_analysis import compare_lines


def test_n1_explicit_owners_override_regulation_title_and_revision(client):
    before = [
        "Положение о финансовой службе ООО «Ромашка» (редакция 2025)",
        "Подразделение: Бухгалтерия",
        "1.1. Хранит первичные документы.",
    ]
    after = [line.replace("2025", "2026") for line in before]
    result = compare_lines(client, before, after)
    assert {unit["name"] for unit in result["units"]} == {"Бухгалтерия"}
    assert [item["status"] for item in result["unit_changes"]] == ["preserved"]
    assert not result["findings"]


@pytest.mark.parametrize(
    "title,name",
    [
        ("об отделе закупок", "Отдел закупок"),
        ("о финансовой службе (редакция 2025)", "Финансовая служба"),
        ("об управлении закупок", "Управление закупок"),
        ("о департаменте контроля", "Департамент контроля"),
    ],
)
def test_n1_inferred_titles_use_common_nominative_forms(client, title, name):
    lines = ["ПОЛОЖЕНИЕ " + title, "3. Функции", "3.1. Проводит проверки."]
    result = compare_lines(client, lines, lines)
    assert {unit["name"] for unit in result["units"]} == {name}
    assert all(result["coverage"].values())


def regulation():
    return [
        "ПОЛОЖЕНИЕ об отделе закупок",
        "1. Общие положения",
        "1.1. Отдел закупок является самостоятельным структурным подразделением Общества.",
        "1.2. Отдел возглавляет начальник, назначаемый приказом директора.",
        "2. Задачи",
        "2.1. Обеспечение Общества товарами и услугами.",
        "3. Функции",
        "3.1. Консолидирует данные филиалов.",
        "3.2. Проводит закупки оборудования.",
        "4. Права",
        "Отдел имеет право:",
        "4.1. Запрашивать сведения.",
        "5. Ответственность",
        "5.1. Начальник отдела несёт ответственность за работу.",
        "6. Взаимодействие",
        "6.1. Взаимодействует с другими отделами.",
        "7. Заключительные положения",
        "7.1. Настоящее Положение вступает в силу завтра.",
    ]


def test_n2_n3_only_function_sections_and_current_owner_rights(client):
    before = regulation()
    after = [
        line.replace("несёт ответственность", "несёт персональную ответственность")
        for line in before
    ]
    result = compare_lines(client, before, after)
    assert {unit["name"] for unit in result["units"]} == {"Отдел закупок"}
    assert len(result["functions"]) == 6
    assert {f["action"] for f in result["functions"]} == {
        "Консолидирует данные филиалов",
        "Проводит закупки оборудования",
        "Запрашивать сведения",
    }
    assert {f["kind"] for f in result["functions"] if f["action"] == "Запрашивать сведения"} == {
        "permission"
    }
    assert all(result["coverage"].values())
    assert not result["findings"]


@pytest.mark.parametrize("subject", ["Отдел", "Управление", "Служба"])
def test_n3_generic_rights_heading_keeps_department(client, subject):
    lines = [
        f"Подразделение: {subject} закупок",
        f"{subject} имеет право:",
        "4.1. Запрашивать сведения.",
    ]
    result = compare_lines(client, lines, lines)
    assert {unit["name"] for unit in result["units"]} == {f"{subject} закупок"}
    assert {unit["kind"] for unit in result["units"]} == {"department"}
    assert {f["kind"] for f in result["functions"]} == {"permission"}


def test_n2_unknown_section_is_warning_not_function(client):
    lines = [
        "Подразделение: Закупки",
        "3. Функции",
        "3.1. Проводит проверки.",
        "6. Организация работы",
        "6.1. Иные общие сведения.",
    ]
    result = compare_lines(client, lines, lines)
    assert {f["action"] for f in result["functions"]} == {"Проводит проверки"}
    assert not any(result["coverage"].values())
    assert any("Организация работы" in warning for warning in result["warnings"])
    # A later section must not make earlier candidate duties disappear silently.
    lines.insert(1, "0.1. Проводит общий аудит.")
    result = compare_lines(client, lines, lines)
    assert any("Проводит общий аудит" in warning for warning in result["warnings"])
    assert not any(result["coverage"].values())


def test_n4_n5_markdown_literals_and_multiline_review(client):
    result = compare_lines(
        client,
        [
            "Подразделение: Аудит",
            "1.1. Проводит проверки `код` *жирный* [x](http://evil).",
            "1.2. Хранит отчёты.",
        ],
        ["Подразделение: Аудит", "1.2. Хранит отчёты."],
    )
    cid = result["comparison_id"]
    fid = result["findings"][0]["id"]
    review = 'ок\nвторая строка\n# [x](http://evil) `код` *курсив* _текст_ | ~ ! \\ <b> & "кавычки"'
    response = client.patch(
        f"/api/v1/comparisons/{cid}/findings/{fid}/review",
        json={"status": "confirmed", "comment": review},
    )
    assert response.status_code == 200
    report = client.get(f"/api/v1/comparisons/{cid}/report?format=markdown").text
    assert r"\[x\](http://evil)" in report and "[x](http://evil)" not in report
    assert r"\`код\`" in report and r"\*жирный\*" in report
    assert "Комментарий:\n> ок  \n> вторая строка  \n> \\#" in report
    assert '&lt;b&gt; &amp; "кавычки"' in report
    assert client.get(f"/api/v1/comparisons/{cid}/result").json()["reviews"][0]["comment"] == review


def test_n6_alias_wins_when_old_name_is_reused(client):
    result = compare_lines(
        client,
        ["Подразделение: Отдел А", "1. Проводит проверки."],
        [
            "Подразделение: Отдел Б",
            "Переименован из: Отдел А",
            "1. Проводит проверки.",
            "Подразделение: Отдел А",
            "2. Хранит документы.",
        ],
    )
    units = {unit["id"]: unit["name"] for unit in result["units"]}
    renamed = next(item for item in result["unit_changes"] if item["status"] == "renamed")
    assert [units[item] for item in renamed["before_ids"]] == ["Отдел А"]
    assert [units[item] for item in renamed["after_ids"]] == ["Отдел Б"]
    assert next(item for item in result["unit_changes"] if item["status"] == "created")["after_ids"]
    assert [item["status"] for item in result["function_changes"]] == ["preserved", "added"]


def test_n7_similar_long_action_is_modified_with_word_difference(client):
    before = [
        "Подразделение: Аудит",
        "1.2. Организует взаимодействие с территориальными органами Федеральной налоговой службы по вопросам крупнейших налогоплательщиков.",
    ]
    after = [line.replace("крупнейших", "крупных") for line in before]
    result = compare_lines(client, before, after)
    assert len(result["function_changes"]) == 1
    change = result["function_changes"][0]
    assert change["status"] == "modified"
    assert "«крупнейших» → «крупных»" in change["explanation"]
    assert not result["findings"]


def test_n7_unrelated_actions_are_not_fuzzy_matches(client):
    result = compare_lines(
        client,
        ["Подразделение: Аудит", "1. Проводит аудит."],
        ["Подразделение: Аудит", "1. Организует корпоративы."],
    )
    assert [item["status"] for item in result["function_changes"]] == ["potential_loss", "added"]


def test_n8_449_functions_in_each_set_complete(client):
    lines = [
        "Подразделение: Аудит",
        *[f"{i}. Проверяет документ номер {i}." for i in range(1, 450)],
    ]
    result = compare_lines(client, lines, lines)
    assert len(result["functions"]) == 898
    assert len(result["function_changes"]) == 449
    assert all(item["status"] == "preserved" for item in result["function_changes"])


def test_n8_limit_is_per_side_and_error_names_counts(client, settings):
    lines = ["Подразделение: Аудит", *[f"{i}. Проверяет документ номер {i}." for i in range(1, 12)]]
    result = compare_lines(client, lines, lines)
    store = client.app.state.store
    comparison = store.get(result["comparison_id"])
    documents = {doc.id: store.document(comparison.id, doc.id)[1] for doc in comparison.documents}
    settings.max_analysis_functions = 11
    assert len(Analyzer(settings).run(comparison, documents, lambda *args: None).functions) == 22
    settings.max_analysis_functions = 10
    with pytest.raises(AppError) as failure:
        Analyzer(settings).run(comparison, documents, lambda *args: None)
    assert failure.value.code == "too_many_functions"
    assert "до — 11, после — 11" in failure.value.message
    assert "каждую сторону — 10" in failure.value.message


@pytest.mark.parametrize(
    "data",
    [
        "Подразделение: Бухгалтерия\n1. Составляет отчётность.".encode("koi8-r"),
        "Résumé du département: café et contrôle.".encode("latin-1"),
    ],
)
def test_n9_ambiguous_legacy_text_is_rejected(data):
    with pytest.raises(AppError, match="UTF-8"):
        decode_plain_text(data)


def test_n9_cp1251_still_reads_real_russian_text():
    source = "ПОЛОЖЕНИЕ\nПодразделение: Бухгалтерия\n1. Составляет отчётность."
    text, warning = decode_plain_text(source.encode("cp1251"))
    assert text == source and "Windows-1251" in warning
