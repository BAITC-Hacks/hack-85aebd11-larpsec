"""Conservative offline baseline; deliberately separate from semantic LLM analysis."""

import re

from app.evidence import normalized, unique_evidence
from app.models import (
    AnalysisPlan,
    Evidence,
    Extraction,
    Fragment,
    Function,
    FunctionDraft,
    FunctionLink,
    IssueDraft,
    ReportingDraft,
    Unit,
    UnitDraft,
    UnitLink,
)

NUMBER = re.compile(r"^\s*\d+(?:\.\d+)*[.)]?\s*")
OWNER = re.compile(r"^(?:Подразделение|Должность|Группа)\s*:\s*(.+)$", re.I)
ACTION = re.compile(
    r"^(?:[а-яa-z][.)]\s*)?(?:провод|организ|осуществ|обеспеч|разрабат|разработ|подгот|готов|формир|утвержд|контрол|провер|оцени|оценк|соглас|анализ|вед[её]|внедр|принима|запраш|представ|участв|коорди|монитор|вынос|оказы|содейств|прием|ведение|ведение|направл)",
    re.I,
)
PROHIBITION = re.compile(r"^(?:Запрещено|Не вправе|Не имеет права|Не имеют права)\s*:?\s*", re.I)
PERMISSION = re.compile(r"^(?:Вправе|Имеет право|Имеют право)\s*:?\s*", re.I)


def extract_demo(fragments: list[Fragment]) -> Extraction:
    units: dict[str, UnitDraft] = {}
    functions = []
    reporting = []
    warnings = []
    owner: str | None = None
    owner_evidence: Evidence | None = None
    inherited_kind = "duty"
    inherited_evidence: Evidence | None = None
    explicit_structure = False
    for fragment in fragments:
        text = NUMBER.sub("", re.sub(r"^[A-Z]{1,3}\d+:\s*", "", fragment.text)).strip()
        source = Evidence(fragment_id=fragment.id, quote=fragment.text)
        explicit = OWNER.match(text)
        explicit_structure |= explicit is not None
        role_heading = (
            text.endswith(":")
            and len(text) < 180
            and re.match(r"^(?:Главный аудитор|Директор|Работники БВА)", text, re.I)
        )
        if explicit or role_heading:
            owner = (explicit.group(1) if explicit else text.rstrip(":")).strip()
            header_prohibition = re.search(r"\s+не име(?:ет|ют) права$", owner, re.I)
            header_permission = re.search(r"\s+име(?:ет|ют) права?$", owner, re.I)
            if header_prohibition or header_permission:
                owner = owner[: (header_prohibition or header_permission).start()]
            kind = (
                "role"
                if re.match(r"^(?:Главный аудитор|Директор|Должность:)", text, re.I)
                else "department"
            )
            units.setdefault(owner, UnitDraft(name=owner, kind=kind, aliases=[], evidence=[source]))
            owner_evidence = source
            inherited_kind = (
                "prohibition"
                if header_prohibition
                else "permission"
                if header_permission
                else "duty"
            )
            inherited_evidence = source if header_prohibition or header_permission else None
            continue
        if text.lower().startswith("переименован из:") and owner:
            units[owner].aliases.append(text.split(":", 1)[1].strip())
            units[owner].evidence.append(source)
            continue
        if not owner:
            continue
        if "подчинение:" in text.lower():
            supervisor = text.split(":", 1)[1].strip()
            reporting.append(
                ReportingDraft(
                    subject=owner,
                    supervisor=supervisor,
                    kind="functional"
                    if "функциональное" in text.lower()
                    else "administrative"
                    if "административное" in text.lower()
                    else "unspecified",
                    evidence=[source],
                )
            )
            continue
        prohibition = PROHIBITION.match(text)
        permission = PERMISSION.match(text)
        if text.lower() in {
            "запрещено:",
            "не имеют права:",
            "не имеет права:",
            "имеют право:",
            "имеет право:",
        }:
            inherited_kind = "prohibition" if prohibition else "permission"
            inherited_evidence = source
            continue
        if not (ACTION.match(text) or prohibition or permission):
            if fragment.clause and re.match(r"^\d+\.[^.]+$", fragment.clause):
                inherited_kind = "duty"
                inherited_evidence = None
            continue
        kind = "prohibition" if prohibition else "permission" if permission else inherited_kind
        action = (PROHIBITION.sub("", text) if prohibition else PERMISSION.sub("", text)).rstrip(
            ".;"
        )
        scope = ""
        match = re.search(r"\s*[;.]\s*Область:\s*(.+)$", action, re.I)
        if match:
            scope = match.group(1).strip()
            action = action[: match.start()].strip()
        evidence = [source, owner_evidence]
        if inherited_evidence:
            evidence.append(inherited_evidence)
        functions.append(
            FunctionDraft(
                owner=owner,
                action=action,
                object="",
                scope=scope,
                kind=kind,
                evidence=unique_evidence(evidence),
            )
        )
    if not functions:
        warnings.append(
            "Демонстрационные правила не извлекли функции: используйте режим llm для свободной структуры документа."
        )
    if not explicit_structure:
        warnings.append(
            "Полнота извлечения свободной структуры демонстрационными правилами не подтверждена."
        )
    return Extraction(
        units=list(units.values()),
        functions=functions,
        reporting=reporting,
        warnings=warnings,
        complete=explicit_structure and bool(functions),
    )


def signature(function: Function) -> tuple[str, str, str]:
    return normalized(function.action), normalized(function.object), normalized(function.scope)


def compare_demo(units: list[Unit], functions: list[Function]) -> AnalysisPlan:
    before_units = [u for u in units if u.side == "before"]
    after_units = [u for u in units if u.side == "after"]
    unit_links = []
    for old in before_units:
        for new in after_units:
            old_names = {normalized(x) for x in [old.name, *old.aliases]}
            new_names = {normalized(x) for x in [new.name, *new.aliases]}
            if old.kind == new.kind and old_names & new_names:
                unit_links.append(
                    UnitLink(
                        before_id=old.id,
                        after_id=new.id,
                        reason="Совпадает название или явно указанное прежнее название.",
                        evidence=unique_evidence(old.evidence + new.evidence),
                    )
                )
    after_functions = [f for f in functions if f.side == "after"]
    function_links = []
    linked = {(x.before_id, x.after_id) for x in unit_links}
    for old in (f for f in functions if f.side == "before"):
        matches = [
            new
            for new in after_functions
            if new.kind == old.kind and signature(new) == signature(old)
        ]
        if matches:
            preferred = [f for f in matches if (old.unit_id, f.unit_id) in linked]
            matches = preferred or matches
            function_links.append(
                FunctionLink(
                    before_id=old.id,
                    after_ids=[f.id for f in matches],
                    relation="equivalent",
                    reason="Совпадают формулировка и явно указанная область (демонстрационные правила).",
                    evidence=unique_evidence(
                        old.evidence + [e for f in matches for e in f.evidence]
                    ),
                )
            )
    issues = []
    for index, left in enumerate(after_functions):
        for right in after_functions[index + 1 :]:
            if signature(left) != signature(right):
                continue
            kind = None
            if left.unit_id != right.unit_id and left.kind == right.kind == "duty":
                # An ancestor/delegate overlap needs semantic interpretation; roles are not
                # enough to assert duplicate departmental responsibilities in offline mode.
                owner_types = {u.id: u.kind for u in units}
                if owner_types[left.unit_id] == owner_types[right.unit_id] == "department":
                    kind = "duplication"
            if left.unit_id == right.unit_id and {left.kind, right.kind} == {"duty", "prohibition"}:
                kind = "conflict"
            if kind:
                issues.append(
                    IssueDraft(
                        kind=kind,
                        function_ids=[left.id, right.id],
                        title="Возможное дублирование функции"
                        if kind == "duplication"
                        else "Обязанность противоречит запрету",
                        explanation=(
                            "Одинаковая функция с одинаковой областью указана у разных подразделений; проверьте делегирование и распределение ответственности."
                            if kind == "duplication"
                            else "У одного владельца одинаковое действие одновременно назначено и запрещено."
                        ),
                        recommendation="Проверить контекст и явно закрепить ответственность или условия исключения.",
                        evidence=unique_evidence(left.evidence + right.evidence),
                    )
                )
    return AnalysisPlan(
        unit_links=unit_links,
        function_links=function_links,
        issues=issues,
        warnings=[
            "Демонстрационный режим: используется буквальное сопоставление, без семантического ИИ. Перефразирования, неявные слияния, разделения и конфликты могут быть пропущены."
        ],
    )
