from collections import defaultdict
from collections.abc import Callable

from app.config import Settings
from app.demo import compare_demo, extract_demo
from app.errors import AppError
from app.evidence import covers, normalized, stable_id, unique_evidence, validate_evidence
from app.llm import COMPARE_PROMPT, EXTRACT_PROMPT, PROMPT_VERSION, ResponsesClient
from app.models import (
    AnalysisPlan,
    Comparison,
    Extraction,
    Finding,
    Fragment,
    Function,
    FunctionChange,
    Reporting,
    Result,
    Unit,
    UnitChange,
)
from app.store import now


def batches(fragments: list[Fragment], limit: int) -> list[list[Fragment]]:
    result, current, size = [], [], 0
    for fragment in fragments:
        if current and size + len(fragment.text) > limit:
            result.append(current)
            current, size = [], 0
        current.append(fragment)
        size += len(fragment.text)
    if current:
        result.append(current)
    return result


class Analyzer:
    def __init__(self, settings: Settings, client: ResponsesClient | None = None):
        self.settings = settings
        self.client = client or ResponsesClient(settings)

    def run(
        self,
        comparison: Comparison,
        by_document: dict[str, list[Fragment]],
        progress: Callable[[str, int], None],
    ) -> Result:
        units: dict[str, Unit] = {}
        functions: dict[str, Function] = {}
        reporting: list[Reporting] = []
        warnings: list[str] = []
        extraction_complete = {"before": True, "after": True}
        all_fragments = {f.id: f for parts in by_document.values() for f in parts}
        for index, doc in enumerate(comparison.documents):
            progress("extracting", 5 + int(45 * index / len(comparison.documents)))
            fragments = by_document[doc.id]
            warnings.extend(f"{doc.filename}: {w}" for w in doc.warnings)
            chunks = (
                batches(fragments, self.settings.extraction_chunk_chars)
                if self.settings.analysis_mode == "llm"
                else [fragments]
            )
            preceding: list[Fragment] = []
            for chunk in chunks:
                known_units = [u for u in units.values() if u.side == doc.side]
                known_fragments = {
                    f.id: f
                    for d in comparison.documents
                    if d.side == doc.side
                    for f in by_document[d.id]
                }
                if self.settings.analysis_mode == "llm":
                    extraction = self.client.call(
                        EXTRACT_PROMPT,
                        {
                            "document": {"filename": doc.filename, "side": doc.side},
                            "known_units": [u.model_dump() for u in known_units],
                            "preceding_fragments": [f.model_dump() for f in preceding[-8:]],
                            "preceding_functions": [
                                f.model_dump()
                                for f in list(functions.values())[-3:]
                                if f.side == doc.side
                            ],
                            "fragments": [f.model_dump() for f in chunk],
                        },
                        Extraction,
                    )
                else:
                    extraction = extract_demo(chunk)
                warnings.extend(f"{doc.filename}: {w}" for w in extraction.warnings)
                extraction_complete[doc.side] &= extraction.complete
                if not extraction.complete:
                    warnings.append(f"{doc.filename}: полнота извлечения функций не подтверждена.")
                for draft in extraction.units:
                    validate_evidence(draft.evidence, known_fragments)
                    uid = stable_id("unit", doc.side, draft.kind, normalized(draft.name))
                    if uid in units:
                        units[uid].evidence = unique_evidence(units[uid].evidence + draft.evidence)
                        units[uid].aliases = sorted(set(units[uid].aliases + draft.aliases))
                    else:
                        units[uid] = Unit(**draft.model_dump(), id=uid, side=doc.side)
                for draft in extraction.functions:
                    validate_evidence(draft.evidence, known_fragments)
                    owners = [
                        u
                        for u in units.values()
                        if u.side == doc.side
                        and normalized(draft.owner) in {normalized(n) for n in [u.name, *u.aliases]}
                    ]
                    if len(owners) != 1:
                        raise AppError(
                            "ambiguous_owner",
                            "Модель не определила однозначного владельца функции.",
                            502,
                        )
                    unit = owners[0]
                    draft.owner = unit.name
                    fid = stable_id(
                        "function",
                        unit.id,
                        draft.kind,
                        normalized(draft.action),
                        normalized(draft.object),
                        normalized(draft.scope),
                    )
                    if fid in functions:
                        functions[fid].evidence = unique_evidence(
                            functions[fid].evidence + draft.evidence
                        )
                    else:
                        functions[fid] = Function(
                            **draft.model_dump(), id=fid, unit_id=unit.id, side=doc.side
                        )
                for relation in extraction.reporting:
                    validate_evidence(relation.evidence, known_fragments)
                    item = Reporting(**relation.model_dump(), side=doc.side)
                    if item not in reporting:
                        reporting.append(item)
                preceding.extend(chunk)
        if not functions:
            raise AppError(
                "no_functions",
                "В документах не извлечены функции. Для свободной структуры используйте llm или проверьте содержимое файлов.",
            )
        if len(functions) > self.settings.max_analysis_functions:
            raise AppError(
                "too_many_functions",
                "Слишком много функций для одного сравнения; разделите комплект по области анализа.",
            )
        progress("comparing", 60)
        unit_list, function_list = list(units.values()), list(functions.values())
        if self.settings.analysis_mode == "llm":
            # Include source texts, not just extracted paraphrases: the model can inspect scope.
            cited = {
                e.fragment_id
                for item in [*unit_list, *function_list, *reporting]
                for e in item.evidence
            }
            plan = self.client.call(
                COMPARE_PROMPT,
                {
                    "units": [u.model_dump() for u in unit_list],
                    "functions": [f.model_dump() for f in function_list],
                    "reporting": [r.model_dump() for r in reporting],
                    "fragments": [all_fragments[x].model_dump() for x in sorted(cited)],
                },
                AnalysisPlan,
            )
        else:
            plan = compare_demo(unit_list, function_list)
        progress("validating", 85)
        validate_plan(plan, units, functions, all_fragments)
        coverage = {
            side: bool(
                getattr(comparison, side + "_complete")
                and extraction_complete[side]
                and all(d.extraction_complete for d in comparison.documents if d.side == side)
                and any(f.side == side for f in function_list)
            )
            for side in ("before", "after")
        }
        warnings.extend(plan.warnings)
        if not all(coverage.values()):
            warnings.append(
                "Полнота обоих комплектов не подтверждена либо есть ограничения извлечения. Отсутствие соответствия не доказывает потерю функции."
            )
        warnings.append(
            "Выводы носят рекомендательный характер. Проверка цитат подтверждает их наличие, но не заменяет оценку смысла ответственным сотрудником."
        )
        changes, findings = function_changes(plan, functions, coverage)
        unit_changes = structure_changes(plan, units)
        summary = (
            f"Сопоставлено подразделений и должностей: до — {sum(u.side == 'before' for u in unit_list)}, "
            f"после — {sum(u.side == 'after' for u in unit_list)}. "
            f"Извлечено функций: до — {sum(f.side == 'before' for f in function_list)}, "
            f"после — {sum(f.side == 'after' for f in function_list)}. "
            f"Потенциальные потери: {sum(f.kind == 'potential_loss' for f in findings)}; "
            f"неопределённые соответствия: {sum(f.kind == 'coverage_gap' for f in findings)}; "
            f"возможные дублирования: {sum(f.kind == 'duplication' for f in findings)}; "
            f"потенциальные конфликты: {sum(f.kind == 'conflict' for f in findings)}. "
            "Все замечания требуют проверки по источникам."
        )
        if self.settings.analysis_mode == "demo":
            summary = "ДЕМОНСТРАЦИОННЫЙ РЕЖИМ БЕЗ ИИ. " + summary
        return Result(
            comparison_id=comparison.id,
            mode=self.settings.analysis_mode,
            model=self.settings.llm_model if self.settings.analysis_mode == "llm" else None,
            prompt_version=PROMPT_VERSION,
            generated_at=now(),
            units=unit_list,
            functions=function_list,
            reporting=reporting,
            unit_changes=unit_changes,
            function_changes=changes,
            findings=findings,
            warnings=list(dict.fromkeys(warnings)),
            coverage=coverage,
            summary=summary,
        )


def validate_plan(
    plan: AnalysisPlan,
    units: dict[str, Unit],
    functions: dict[str, Function],
    fragments: dict[str, Fragment],
) -> None:
    def check_item(item_id: str, items: dict, side: str):
        item = items.get(item_id)
        if item is None or item.side != side:
            raise AppError(
                "invalid_analysis_reference",
                "Модель сослалась на неизвестный элемент или неверный комплект.",
                502,
            )
        return item

    for link in plan.unit_links:
        old, new = (
            check_item(link.before_id, units, "before"),
            check_item(link.after_id, units, "after"),
        )
        validate_evidence(link.evidence, fragments)
        if old.kind != new.kind or not all(covers(link.evidence, x.evidence) for x in (old, new)):
            raise AppError(
                "invalid_unit_mapping",
                "Связь подразделений не подтверждена источниками обеих сторон или смешивает типы субъектов.",
                502,
            )
    seen = set()
    for link in plan.function_links:
        old = check_item(link.before_id, functions, "before")
        if old.id in seen:
            raise AppError(
                "duplicate_mapping", "Модель дважды сопоставила одну исходную функцию.", 502
            )
        seen.add(old.id)
        if len(set(link.after_ids)) != len(link.after_ids):
            raise AppError("duplicate_mapping", "В сопоставлении повторяются целевые функции.", 502)
        targets = [check_item(fid, functions, "after") for fid in link.after_ids]
        validate_evidence(link.evidence, fragments)
        if not all(
            covers(link.evidence, item.evidence, primary_only=True) for item in [old, *targets]
        ):
            raise AppError(
                "unsupported_mapping",
                "Сопоставление функций не подтверждено источниками каждого участника.",
                502,
            )
        if link.relation == "equivalent" and any(t.kind != old.kind for t in targets):
            raise AppError(
                "invalid_function_mapping",
                "Обязанность, право и запрет нельзя считать эквивалентными.",
                502,
            )
    for issue in plan.issues:
        if len(set(issue.function_ids)) < 2:
            raise AppError(
                "unsupported_issue", "Для пересечения нужны как минимум две различные функции.", 502
            )
        involved = [check_item(fid, functions, "after") for fid in issue.function_ids]
        validate_evidence(issue.evidence, fragments)
        if not all(covers(issue.evidence, item.evidence, primary_only=True) for item in involved):
            raise AppError(
                "unsupported_issue",
                "Замечание не подтверждено источниками каждой затронутой функции.",
                502,
            )
        if issue.kind == "duplication" and len({f.unit_id for f in involved}) < 2:
            raise AppError(
                "unsupported_issue",
                "Межподразделенческое дублирование требует разных владельцев.",
                502,
            )


def structure_changes(plan: AnalysisPlan, units: dict[str, Unit]) -> list[UnitChange]:
    adjacency: dict[str, set[str]] = defaultdict(set)
    for link in plan.unit_links:
        adjacency[link.before_id].add(link.after_id)
        adjacency[link.after_id].add(link.before_id)
    visited, changes = set(), []
    for uid in units:
        if uid in visited:
            continue
        component, pending = set(), [uid]
        while pending:
            current = pending.pop()
            if current in component:
                continue
            component.add(current)
            pending.extend(adjacency[current] - component)
        visited |= component
        before = sorted(x for x in component if units[x].side == "before")
        after = sorted(x for x in component if units[x].side == "after")
        if not before:
            status, explanation = (
                "created",
                "В исходном комплекте соответствие не найдено; возможно новое подразделение/должность.",
            )
        elif not after:
            status, explanation = (
                "unmatched",
                "В комплекте после соответствие не найдено; проверьте полноту документов и возможное преобразование.",
            )
        elif len(before) > 1 and len(after) > 1:
            status, explanation = (
                "reorganized",
                "Выявлено сопоставление нескольких субъектов до и после.",
            )
        elif len(before) > 1:
            status, explanation = (
                "merged",
                "Несколько исходных субъектов сопоставлены одному: возможное объединение.",
            )
        elif len(after) > 1:
            status, explanation = (
                "split",
                "Один исходный субъект сопоставлен нескольким: возможное разделение.",
            )
        elif normalized(units[before[0]].name) == normalized(units[after[0]].name):
            status, explanation = "preserved", "Субъект сопоставлен с сохранением названия."
        else:
            status, explanation = "renamed", "Субъект сопоставлен под другим названием."
        reasons = list(
            dict.fromkeys(link.reason for link in plan.unit_links if link.before_id in component)
        )
        changes.append(
            UnitChange(
                before_ids=before,
                after_ids=after,
                status=status,
                explanation=" ".join([explanation, *reasons]),
                evidence=unique_evidence([e for x in sorted(component) for e in units[x].evidence]),
            )
        )
    return changes


def function_changes(plan: AnalysisPlan, functions: dict[str, Function], coverage: dict[str, bool]):
    links = {link.before_id: link for link in plan.function_links}
    unit_links = {(link.before_id, link.after_id) for link in plan.unit_links}
    changes, findings, matched = [], [], set()
    for old in (f for f in functions.values() if f.side == "before"):
        if link := links.get(old.id):
            matched.update(link.after_ids)
            status = "modified" if link.relation == "modified" else "preserved"
            if status == "preserved" and any(
                (old.unit_id, functions[x].unit_id) not in unit_links for x in link.after_ids
            ):
                status = "moved"
            changes.append(
                FunctionChange(
                    before_id=old.id,
                    after_ids=link.after_ids,
                    status=status,
                    explanation=link.reason,
                    evidence=link.evidence,
                )
            )
        else:
            complete = all(coverage.values())
            explanation = (
                "Соответствие исходной функции не найдено среди извлечённых функций всего комплекта после. "
                + (
                    "Возможна потеря функции; проверьте перефразирования, извлечение и распределение ответственности."
                    if complete
                    else "Полнота данных не подтверждена, поэтому потерю функции установить нельзя."
                )
            )
            changes.append(
                FunctionChange(
                    before_id=old.id,
                    after_ids=[],
                    status="potential_loss" if complete else "unmatched",
                    explanation=explanation,
                    evidence=old.evidence,
                )
            )
            findings.append(
                Finding(
                    id=stable_id("finding", "loss", old.id),
                    kind="potential_loss" if complete else "coverage_gap",
                    title="Возможная потеря функции"
                    if complete
                    else "Недостаточно данных о сохранении функции",
                    explanation=explanation,
                    function_ids=[old.id],
                    evidence=old.evidence,
                    recommendation="Проверить полный комплект после и подтвердить нового ответственного за функцию.",
                )
            )
    for new in (f for f in functions.values() if f.side == "after" and f.id not in matched):
        changes.append(
            FunctionChange(
                before_id=None,
                after_ids=[new.id],
                status="added",
                explanation="Сопоставленная исходная функция не найдена; возможно новая функция или неполнота извлечения.",
                evidence=new.evidence,
            )
        )
    seen = set()
    for issue in plan.issues:
        fid = stable_id("finding", issue.kind, *sorted(set(issue.function_ids)))
        if fid in seen:
            continue
        seen.add(fid)
        findings.append(Finding(id=fid, **issue.model_dump()))
    return changes, findings
