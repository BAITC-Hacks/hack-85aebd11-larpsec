import html

from app.models import Comparison, Result
from app.store import Store


def report_markdown(comparison: Comparison, result: Result, store: Store) -> str:
    def safe(value: str) -> str:
        # Prevent document text from introducing HTML/links into an exported Markdown report.
        text = html.escape(value)
        for char in ("\\", "`", "*", "_", "[", "]", "#", "|", "~"):
            text = text.replace(char, "\\" + char)
        return text.replace("\n", " ")

    docs = {d.id: d for d in comparison.documents}
    fragments = {f.id: f for d in docs.values() for f in store.document(comparison.id, d.id)[1]}
    lines = [
        f"# {safe(comparison.title)}",
        "",
        f"Дата: {result.generated_at}",
        f"Режим: {result.mode}; модель: {safe(result.model or 'не используется')}",
        "",
        result.summary,
        "",
        "## Состав документов",
        "",
    ]
    for doc in docs.values():
        lines.append(f"- {doc.side}: {safe(doc.filename)}; SHA-256: `{doc.sha256}`")
    lines.extend(["", "## Ограничения", ""])
    lines.extend(f"- {safe(w)}" for w in result.warnings)
    lines.extend(["", "## Изменения структуры", ""])
    unit_names = {u.id: u.name for u in result.units}
    for change in result.unit_changes:
        old = ", ".join(unit_names[x] for x in change.before_ids) or "—"
        new = ", ".join(unit_names[x] for x in change.after_ids) or "—"
        lines.append(
            f"- **{change.status}**: {safe(old)} → {safe(new)}. {safe(change.explanation)}"
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
        f = funcs[fid]
        kind = {"duty": "Обязанность", "permission": "Право", "prohibition": "Запрет"}[f.kind]
        return safe(f"{kind} — {f.owner}: {f.action}; {f.object}; {f.scope}")

    evidence_number = 0

    def citations(items):
        nonlocal evidence_number
        for evidence in items:
            evidence_number += 1
            frag = fragments[evidence.fragment_id]
            doc = docs[frag.document_id]
            lines.extend(
                [
                    "",
                    f"Источник {evidence_number}: {safe(doc.filename)} — {safe(frag.locator)}"
                    + (f", п. {safe(frag.clause)}" if frag.clause else ""),
                    f"> {safe(evidence.quote)}",
                ]
            )

    for change in result.function_changes:
        lines.append(
            f"| {label(change.before_id) if change.before_id else '—'} | "
            f"{' / '.join(label(x) for x in change.after_ids) or '—'} | {change.status} | {safe(change.explanation)} |"
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
                safe(finding.explanation),
                "",
                f"Рекомендация: {safe(finding.recommendation)}",
                f"Проверка сотрудником: {review.status if review else 'unreviewed'}",
            ]
        )
        if review and review.comment:
            lines.append(f"Комментарий: {safe(review.comment)}")
        citations(finding.evidence)
        lines.append("")
    return "\n".join(lines) + "\n"
