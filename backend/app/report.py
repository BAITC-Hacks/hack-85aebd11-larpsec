import html
import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.models import (
    Comparison,
    Document,
    Evidence,
    Finding,
    Fragment,
    Function,
    FunctionChange,
    Reporting,
    Result,
    Side,
    Unit,
    UnitChange,
)
from app.store import Store

SIDES = {"before": "До реорганизации", "after": "После реорганизации"}
UNIT_STATUSES = {
    "preserved": "Сохранено",
    "renamed": "Переименовано",
    "merged": "Объединено",
    "split": "Разделено",
    "reorganized": "Реорганизовано",
    "created": "Новое",
    "unmatched": "Не сопоставлено",
}
FUNCTION_STATUSES = {
    "preserved": "Сохранена",
    "moved": "Передана",
    "modified": "Изменена",
    "potential_loss": "Возможная потеря",
    "unmatched": "Не сопоставлена",
    "added": "Добавлена",
}
REVIEW_STATUSES = {
    "unreviewed": "Не проверено",
    "confirmed": "Подтверждено",
    "dismissed": "Отклонено",
}
FINDING_KINDS = {
    "potential_loss": "Возможная потеря функции",
    "duplication": "Возможное дублирование",
    "conflict": "Возможное противоречие",
    "coverage_gap": "Недостаточно данных",
    "reporting_change": "Изменение подчинения",
}


class SourceDetails(BaseModel):
    document_id: str
    filename: str
    side: Side
    sha256: str
    locator: str
    clause: str | None
    page: int | None
    sheet: str | None
    cell_range: str | None


class ExportEvidence(Evidence, SourceDetails):
    """A quotation with enough context to identify its source without the server."""


class ExportSource(Fragment):
    filename: str
    side: Side
    sha256: str


class ExportUnit(Unit):
    evidence: list[ExportEvidence]


class ExportFunction(Function):
    evidence: list[ExportEvidence]


class ExportReporting(Reporting):
    evidence: list[ExportEvidence]


class ExportUnitChange(UnitChange):
    evidence: list[ExportEvidence]


class ExportFunctionChange(FunctionChange):
    evidence: list[ExportEvidence]


class ExportFinding(Finding):
    evidence: list[ExportEvidence]


class ReportExport(Result):
    """Download format; GET /result keeps its compact analysis contract."""

    export_version: Literal[1] = 1
    comparison: Comparison
    documents: list[Document]
    sources: list[ExportSource]
    units: list[ExportUnit]
    functions: list[ExportFunction]
    reporting: list[ExportReporting]
    unit_changes: list[ExportUnitChange]
    function_changes: list[ExportFunctionChange]
    findings: list[ExportFinding]


def report_export(comparison: Comparison, result: Result, store: Store) -> ReportExport:
    documents = {document.id: document for document in comparison.documents}
    fragments = {
        fragment.id: fragment
        for document in documents.values()
        for fragment in store.document(comparison.id, document.id)[1]
    }
    sources = {
        fragment.id: ExportSource(
            **fragment.model_dump(),
            filename=documents[fragment.document_id].filename,
            side=documents[fragment.document_id].side,
            sha256=documents[fragment.document_id].sha256,
        )
        for fragment in fragments.values()
    }
    data = result.model_dump()
    for field in (
        "units",
        "functions",
        "reporting",
        "unit_changes",
        "function_changes",
        "findings",
    ):
        for item in data[field]:
            for evidence in item["evidence"]:
                source = sources[evidence["fragment_id"]]
                evidence.update(source.model_dump(exclude={"id", "text"}))
    return ReportExport(
        **data,
        comparison=comparison,
        documents=comparison.documents,
        sources=list(sources.values()),
    )


def readable_date(value: str) -> str:
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        zone = date.strftime("%z")
        suffix = f" UTC{zone[:3]}:{zone[3:]}" if zone else ""
        return date.strftime("%d.%m.%Y %H:%M:%S") + suffix
    except ValueError:
        return value


def report_markdown(comparison: Comparison, result: Result, store: Store) -> str:
    def safe(value: str) -> str:
        # Escape user text as literal Markdown while retaining quotation marks.
        escaped = html.escape(value, quote=False)
        escaped = re.sub(r"([\\`*_\[\]#|~!])", r"\\\1", escaped)
        escaped = re.sub(r"^(\s*)([-+]|\d+[.)])(?=\s)", r"\1\\\2", escaped)
        return escaped.replace("\n", " ").replace("\r", " ")

    def table_text(value: str) -> str:
        # A literal pipe must not create a new table column.
        return safe(value).replace(r"\|", "&#124;")

    docs = {d.id: d for d in comparison.documents}
    fragments = {f.id: f for d in docs.values() for f in store.document(comparison.id, d.id)[1]}
    mode = "Демонстрационный анализ" if result.mode == "demo" else "Анализ языковой моделью"
    lines = [
        f"# {safe(comparison.title)}",
        "",
        f"Дата: {safe(readable_date(result.generated_at))}",
        f"Режим: {mode}; модель: {safe(result.model or 'не используется')}",
        "",
        safe(result.summary),
        "",
        "## Состав документов",
        "",
    ]
    for doc in docs.values():
        lines.append(f"- {SIDES[doc.side]}: {safe(doc.filename)}; SHA-256: `{doc.sha256}`")
    lines.extend(["", "## Ограничения", ""])
    lines.extend(f"- {safe(w)}" for w in result.warnings)
    if not result.warnings:
        lines.append("Дополнительных ограничений не указано.")
    lines.extend(["", "## Изменения структуры", ""])
    unit_names = {u.id: u.name for u in result.units}
    for change in result.unit_changes:
        old = ", ".join(unit_names[x] for x in change.before_ids) or "—"
        new = ", ".join(unit_names[x] for x in change.after_ids) or "—"
        lines.append(
            f"- **{UNIT_STATUSES[change.status]}**: {safe(old)} → {safe(new)}. {safe(change.explanation)}"
        )
    lines.extend(
        [
            "",
            "## Сопоставление функций",
            "",
            "| До | После | Статус | Обоснование |",
            "| --- | --- | --- | --- |",
        ]
    )
    funcs = {f.id: f for f in result.functions}

    def label(fid: str) -> str:
        function = funcs[fid]
        kind = {"duty": "Обязанность", "permission": "Право", "prohibition": "Запрет"}[
            function.kind
        ]
        action = function.action.strip()
        details = [f"{kind} — {function.owner}: {action}"]
        if function.object.strip():
            details.append(f"Объект: {function.object.strip()}")
        if function.scope.strip():
            details.append(f"Область: {function.scope.strip()}")
        return table_text("; ".join(details))

    evidence_number = 0

    def citations(items):
        nonlocal evidence_number
        for evidence in items:
            evidence_number += 1
            frag = fragments[evidence.fragment_id]
            doc = docs[frag.document_id]
            location = f"{SIDES[doc.side]}, {safe(doc.filename)} — {safe(frag.locator)}"
            if frag.clause:
                location += f", п. {safe(frag.clause)}"
            if frag.page:
                location += f", стр. {frag.page}"
            lines.extend(
                ["", f"Источник {evidence_number}: {location}", f"> {safe(evidence.quote)}"]
            )

    for change in result.function_changes:
        lines.append(
            f"| {label(change.before_id) if change.before_id else '—'} | "
            f"{' / '.join(label(x) for x in change.after_ids) or '—'} | "
            f"{FUNCTION_STATUSES[change.status]} | {table_text(change.explanation)} |"
        )
    lines.extend(["", "## Источники сопоставления", ""])
    for index, change in enumerate(result.function_changes, 1):
        lines.append(f"\nСопоставление функции № {index}:")
        citations(change.evidence)
    lines.extend(["", "## Источники изменений структуры", ""])
    for index, change in enumerate(result.unit_changes, 1):
        lines.append(f"\nИзменение структуры № {index}:")
        citations(change.evidence)
    lines.extend(["", "## Замечания для проверки", ""])
    reviews = {r.finding_id: r for r in result.reviews}
    for index, finding in enumerate(result.findings, 1):
        review = reviews.get(finding.id)
        lines.extend(
            [
                f"### {index}. {safe(finding.title)}",
                "",
                f"Тип: {FINDING_KINDS[finding.kind]}",
                "",
                safe(finding.explanation),
                "",
                f"Рекомендация: {safe(finding.recommendation)}",
                f"Проверка сотрудником: {REVIEW_STATUSES[review.status if review else 'unreviewed']}",
            ]
        )
        if review:
            lines.append(f"Дата проверки: {safe(readable_date(review.updated_at))}")
            if review.comment:
                lines.append("Комментарий:")
                lines.extend(f"> {safe(line)}  " for line in review.comment.splitlines())
        citations(finding.evidence)
        lines.append("")
    if not result.findings:
        lines.append("Замечаний для проверки не сформировано.")
    return "\n".join(lines) + "\n"
