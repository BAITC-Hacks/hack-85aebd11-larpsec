"""Conservative offline baseline; deliberately separate from semantic LLM analysis."""

import re
from difflib import SequenceMatcher

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

NUMBER = re.compile(r"^\s*(\d+(?:\.\d+)*)(?:[.)]\s*|\s+)")
BULLET = re.compile(r"^[-–—•·*]\s*")
OWNER = re.compile(r"^(Подразделение|Должность|Группа)\s*:\s*(.+)$", re.I)
RENAME = re.compile(r"^(?:переименован[аоы]?\s+из|прежнее\s+наименование|ранее)\s*:\s*(.+)$", re.I)
ACTION = re.compile(
    r"^(?:[а-яa-z][.)]\s*)?(?:провод|организ|осуществ|обеспеч|разрабат|разработ|подгот|готов|формир|утвержд|контрол|провер|оцени|оценк|соглас|анализ|вед[её]|внедр|принима|запраш|представ|участв|коорди|монитор|вынос|оказы|содейств|прием|ведение|направл|составл|начисл|выполн|хран|подпис|оформл|рассматр|исполн|определ|устанавл|информир|регистрир|учитыв|назнач|изда|выда|консульт|взаимодейств|рассчит)",
    re.I,
)
PROHIBITION = re.compile(r"^(?:Запрещено|Не вправе|Не имеет права|Не имеют права)\s*:?\s*", re.I)
PERMISSION = re.compile(r"^(?:Вправе|Имеет право|Имеют право)\s*:?\s*", re.I)
REGULATION = re.compile(r"^положение\s+(?:об|о)\s+(.+?)[.:]?$", re.I)
FUNCTIONS_HEADING = re.compile(r"^(?:функции|обязанности)\s+(.+?)[.:]?$", re.I)
SECTION = re.compile(
    r"^(?:общие положения|основные задачи|задачи|функции|права|обязанности|запреты|ответственность|взаимодействие|заключительные положения)(?:\s+[^.!?:]+)?[.:]?$",
    re.I,
)
FUNCTION_SECTION = re.compile(r"^(?:функци|обязанност|права\b|запрет)", re.I)
GENERIC_SUBJECTS = {
    "отдел",
    "подразделение",
    "управление",
    "служба",
    "департамент",
    "бюро",
    "группа",
}


def fragment_body(fragment: Fragment) -> str:
    raw = re.sub(r"^[A-Z]{1,3}\d+:\s*", "", fragment.text).strip()
    number = NUMBER.match(raw) if fragment.clause else None
    return " ".join((raw[number.end() :] if number else raw).split())


def heading_owner_name(name: str) -> str:
    """Normalize common title noun cases; keep qualifiers and evidence intact."""
    name = re.sub(r"\s*\(\s*редакци[^)]*\)\s*$", "", name, flags=re.I).strip()
    words = name.split()
    for index, word in enumerate(words):
        noun = heading_owner_key(word)
        if noun in GENERIC_SUBJECTS:
            words[index] = noun
            for adjective in range(index):
                value = words[adjective]
                if noun in {"служба", "группа"}:
                    value = re.sub(r"ой$", "ая", value)
                    value = re.sub(r"ей$", "яя", value)
                words[adjective] = value
            break
    name = " ".join(words)
    return name[:1].upper() + name[1:]


def heading_owner_key(name: str) -> str:
    """Match the noun cases used by a regulation title and its function heading."""
    words = normalized(name).split()
    if words:
        for root, forms in (
            ("отдел", {"отдел", "отдела", "отделе"}),
            ("управление", {"управление", "управления", "управлении"}),
            ("департамент", {"департамент", "департамента", "департаменте"}),
            ("служба", {"служба", "службы", "службе"}),
            ("бюро", {"бюро"}),
            ("группа", {"группа", "группы", "группе"}),
        ):
            if words[0] in forms:
                words[0] = root
                break
    return " ".join(words)


def extract_demo(fragments: list[Fragment]) -> Extraction:
    units: dict[str, UnitDraft] = {}
    functions, reporting, warnings = [], [], []
    owner: str | None = None
    owner_evidence: Evidence | None = None
    inherited_kind = "duty"
    inherited_evidence: Evidence | None = None
    recognized_structure = False
    unresolved = False
    regulation_pending = False
    explicit_structure = any(OWNER.match(fragment_body(f)) for f in fragments)
    sectioned = any(SECTION.match(fragment_body(f)) for f in fragments)
    in_functions = None if sectioned else True

    def warn(fragment: Fragment, reason: str) -> None:
        nonlocal unresolved
        unresolved = True
        warnings.append(f"{fragment.locator}: не распознано — {reason}: «{fragment.text}».")

    for fragment in fragments:
        raw = re.sub(r"^[A-Z]{1,3}\d+:\s*", "", fragment.text).strip()
        # Strip only a number confirmed by the parser. Bare years/quantities are not clauses.
        number = NUMBER.match(raw) if fragment.clause else None
        text = raw[number.end() :] if number else raw
        bulleted = bool(BULLET.match(text))
        text = " ".join(BULLET.sub("", text).split()).strip()
        source = Evidence(fragment_id=fragment.id, quote=fragment.text)
        if text.casefold() == "положение":
            regulation_pending = not explicit_structure
            continue
        if regulation_pending:
            regulation_pending = False
            title = REGULATION.match("Положение " + text)
        else:
            title = REGULATION.match(text)
        if explicit_structure and (title or re.match(r"^(?:о|об)\s+", text, re.I)):
            continue
        explicit = OWNER.match(text)
        function_heading = FUNCTIONS_HEADING.match(text)
        prohibition = PROHIBITION.match(text)
        permission = PERMISSION.match(text)
        # Generic grammatical subject heading, with no organizer-specific names.
        subject_heading = re.match(
            r"^(.+?)\s+(не име(?:ет|ют) права|име(?:ет|ют) прав[ао])\s*:$", text, re.I
        )
        rename = RENAME.match(text)
        heading_subject = function_heading.group(1).strip() if function_heading else None
        generic_section = heading_subject and normalized(heading_subject) in {
            "отдела",
            "подразделения",
            "управления",
            "службы",
            "департамента",
            "бюро",
            "работников",
        }
        same_owner = (
            owner
            and heading_subject
            and heading_owner_key(owner) == heading_owner_key(heading_subject)
        )
        new_heading_owner = function_heading and (not owner or not (generic_section or same_owner))
        # Generic references keep the current department; full names may introduce a subject.
        if (
            subject_heading
            and owner
            and (
                normalized(subject_heading.group(1)) in GENERIC_SUBJECTS
                or heading_owner_key(owner) == heading_owner_key(subject_heading.group(1))
            )
        ):
            inherited_kind = (
                "prohibition"
                if subject_heading.group(2).lower().startswith("не ")
                else "permission"
            )
            inherited_evidence = source
            in_functions = True
            continue
        if explicit or title or subject_heading or new_heading_owner:
            if explicit:
                owner = explicit.group(2).strip()
                kind = {"подразделение": "department", "должность": "role", "группа": "group"}[
                    explicit.group(1).casefold()
                ]
            elif title:
                owner, kind = heading_owner_name(title.group(1)), "department"
                if not sectioned:
                    warn(fragment, "владелец определён по заголовку, но разделы функций не распознаны")
            elif function_heading:
                owner, kind = heading_owner_name(function_heading.group(1)), "department"
            else:
                owner = subject_heading.group(1).strip()
                kind = (
                    "group"
                    if re.match(r"^(?:работники|сотрудники|участники|члены|группа)\b", owner, re.I)
                    else "department"
                    if heading_owner_key(owner).split()[0] in GENERIC_SUBJECTS
                    else "role"
                )
            recognized_structure = True
            units.setdefault(owner, UnitDraft(name=owner, kind=kind, aliases=[], evidence=[source]))
            owner_evidence = source
            inherited_kind = (
                "prohibition"
                if subject_heading and subject_heading.group(2).lower().startswith("не ")
                else "permission"
                if subject_heading
                else "duty"
            )
            inherited_evidence = source if subject_heading else None
            in_functions = True if subject_heading or new_heading_owner or not sectioned else None
            continue
        if rename:
            if owner:
                units[owner].aliases.append(rename.group(1).strip())
                units[owner].evidence.append(source)
            else:
                warn(fragment, "не определён владелец прежнего наименования")
            continue
        if re.match(r"^(?:(?:функциональное|административное)\s+)?подчинение\s*:", text, re.I):
            if not owner:
                warn(fragment, "не определён субъект подчинения")
                continue
            supervisor = text.split(":", 1)[1].strip()
            if not supervisor:
                warn(fragment, "не указан руководитель")
                continue
            reporting.append(
                ReportingDraft(
                    subject=owner,
                    supervisor=supervisor,
                    kind="functional"
                    if text.casefold().startswith("функциональное")
                    else "administrative"
                    if text.casefold().startswith("административное")
                    else "unspecified",
                    evidence=[source],
                )
            )
            continue
        if SECTION.match(text) or function_heading:
            in_functions = bool(FUNCTION_SECTION.match(text))
            inherited_kind = (
                "permission"
                if text.casefold().startswith("права")
                else "prohibition"
                if text.casefold().startswith("запрет")
                else "duty"
            )
            inherited_evidence = source if inherited_kind != "duty" else None
            continue
        stripped = (PROHIBITION.sub("", text) if prohibition else PERMISSION.sub("", text)).strip()
        if (prohibition or permission) and not stripped:
            if not owner:
                warn(fragment, "не определён владелец списка")
            inherited_kind = "prohibition" if prohibition else "permission"
            inherited_evidence = source
            in_functions = True
            continue
        if sectioned and in_functions is False:
            continue
        if in_functions is None:
            if fragment.clause or bulleted or ACTION.match(text) or prohibition or permission:
                warn(fragment, "возможная функция находится до распознанного раздела")
            continue
        if (
            fragment.clause
            and "." not in fragment.clause
            and len(text.split()) <= 5
            and re.search(r"(?:ция|ние|ность|сведения)$", text.split()[0].lower().rstrip(".:;"))
        ):
            warn(fragment, "не распознан раздел документа")
            sectioned, in_functions = True, False
            continue
        candidate = bool(
            fragment.clause or bulleted or ACTION.match(text) or prohibition or permission
        )
        if not owner:
            if candidate:
                warn(fragment, "не определён владелец возможной функции")
            continue
        if fragment.clause and not (ACTION.match(text) or prohibition or permission):
            # Unknown chapter labels and declarative provisions are not duties.
            first_word = text.split()[0].lower().rstrip(".:;")
            chapter_label = "." not in fragment.clause and not re.search(
                r"(?:[еёюуия]т|ать|ить|еть|ти|чь)(?:ся)?$", first_word
            )
            if (
                chapter_label
                or len(text.rstrip(".:;").split()) < 2
                or re.search(
                    r"\b(?:является|возглавляет|нес[её]т\s+(?:персональную\s+)?ответственность|вступает\s+в\s+силу)\b",
                    text,
                    re.I,
                )
            ):
                warn(fragment, "пункт не содержит распознанной функции")
                if "." not in fragment.clause:
                    in_functions = False
                    sectioned = True
                continue
        if not candidate:
            # Do not silently claim completeness for prose the literal rules cannot interpret.
            if text and not re.match(
                r"^(?:примечание|утвержден[аоы]?|дата|редакция)\b", text, re.I
            ):
                warn(fragment, "строка внутри блока владельца не распознана как функция")
            continue
        if not stripped.rstrip(".;:"):
            warn(fragment, "пустой пункт функции")
            continue
        kind = "prohibition" if prohibition else "permission" if permission else inherited_kind
        action = stripped.rstrip(".;")
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
            "Структура функций не распознана: не найдены функции с определённым владельцем. Доступно сравнение текста документов."
        )
    if not recognized_structure:
        warnings.append("Структура документа не распознана: полнота извлечения не подтверждена.")
    return Extraction(
        units=list(units.values()),
        functions=functions,
        reporting=reporting,
        warnings=warnings,
        complete=recognized_structure and bool(functions) and not unresolved,
    )


def action_signature(action: str) -> str:
    """Only normalize the first verb's inflection; retain objects, negation and qualifiers."""
    tokens = normalized(action).split()
    if not tokens:
        return ""
    verb = tokens[0]
    for endings in (
        r"(?:овать|ует|уют|уешь|уем|уете)$",
        r"(?:ывать|ывает|ывают|ываешь|ываем|ываете)$",
        r"(?:ивать|ивает|ивают|иваешь|иваем|иваете)$",
        r"(?:ать|ает|ают|аешь|аем|аете)$",
        r"(?:ять|яет|яют|яешь|яем|яете)$",
        r"(?:ить|ит|ят|ишь|им|ите)$",
        r"(?:еть|еет|еют|еешь|еем|еете)$",
    ):
        stem = re.sub(endings, "", verb)
        if stem != verb and len(stem) >= 3:
            tokens[0] = stem
            break
    return " ".join(tokens)


def signature(function: Function) -> tuple[str, str, str]:
    return (
        action_signature(function.action),
        normalized(function.object),
        normalized(function.scope),
    )


def compare_demo(units: list[Unit], functions: list[Function]) -> AnalysisPlan:
    before_units = [u for u in units if u.side == "before"]
    after_units = [u for u in units if u.side == "after"]
    unit_links = []
    for old in before_units:
        renamed = [
            new
            for new in after_units
            if old.kind == new.kind and normalized(old.name) in {normalized(n) for n in new.aliases}
        ]
        exact = [
            new
            for new in after_units
            if old.kind == new.kind and normalized(old.name) == normalized(new.name)
        ]
        for new in renamed or exact or after_units:
            old_names = {normalized(x) for x in [old.name, *old.aliases]}
            new_names = {normalized(x) for x in [new.name, *new.aliases]}
            if old.kind == new.kind and old_names & new_names:
                unit_links.append(
                    UnitLink(
                        before_id=old.id,
                        after_id=new.id,
                        reason="Явно указано прежнее название; оно имеет приоритет перед повторным использованием имени."
                        if renamed
                        else "Совпадает название или явно указанное прежнее название.",
                        evidence=unique_evidence(old.evidence + new.evidence),
                    )
                )
    after_functions = [f for f in functions if f.side == "after"]
    before_functions = [f for f in functions if f.side == "before"]
    signatures = {f.id: signature(f) for f in functions}
    used_fuzzy: set[str] = set()
    function_links = []
    linked = {(x.before_id, x.after_id) for x in unit_links}
    reserved = {
        new.id
        for new in after_functions
        if any(
            (old.unit_id, new.unit_id) in linked
            and signatures[old.id][:2] == signatures[new.id][:2]
            for old in before_functions
        )
    }
    for old in before_functions:
        candidates = [
            new for new in after_functions if signatures[new.id][:2] == signatures[old.id][:2]
        ]
        exact = [
            new
            for new in candidates
            if new.kind == old.kind and signatures[new.id] == signatures[old.id]
        ]
        preferred = [new for new in candidates if (old.unit_id, new.unit_id) in linked]
        preferred_exact = [new for new in exact if (old.unit_id, new.unit_id) in linked]
        matches = preferred_exact or preferred or exact or candidates
        if not preferred:
            similar = []
            old_tokens = signatures[old.id][0].split()
            if len(old_tokens) >= 6:
                for new in after_functions:
                    if (
                        new.id in reserved
                        or new.id in used_fuzzy
                        or (old.unit_id, new.unit_id) not in linked
                    ):
                        continue
                    new_tokens = signatures[new.id][0].split()
                    score = SequenceMatcher(None, old_tokens, new_tokens, autojunk=False).ratio()
                    if score >= 0.85 and len(new_tokens) >= 6:
                        similar.append((score, new))
            similar.sort(key=lambda item: item[0], reverse=True)
            # Ambiguous near-identical duties need human review, not arbitrary pairing.
            if similar and (len(similar) == 1 or similar[0][0] > similar[1][0]):
                matches = [similar[0][1]]
                used_fuzzy.add(matches[0].id)
        if matches:
            modified = any(
                new.kind != old.kind or signatures[new.id] != signatures[old.id] for new in matches
            )
            differences = []
            kind_labels = {"duty": "обязанность", "permission": "право", "prohibition": "запрет"}
            for new in matches:
                if new.kind != old.kind:
                    differences.append(f"вид: {kind_labels[old.kind]} → {kind_labels[new.kind]}")
                if signatures[new.id][2] != signatures[old.id][2]:
                    differences.append(
                        f"область: {old.scope or 'не указана'} → {new.scope or 'не указана'}"
                    )
                if signatures[new.id][:2] != signatures[old.id][:2]:
                    left, right = old.action.split(), new.action.split()
                    for tag, a, b, c, d in SequenceMatcher(
                        None, left, right, autojunk=False
                    ).get_opcodes():
                        if tag != "equal":
                            differences.append(
                                f"формулировка: «{' '.join(left[a:b]) or '∅'}» → «{' '.join(right[c:d]) or '∅'}»"
                            )
            function_links.append(
                FunctionLink(
                    before_id=old.id,
                    after_ids=[f.id for f in matches],
                    relation="modified" if modified else "equivalent",
                    reason=("Изменены " + "; ".join(dict.fromkeys(differences)) + ".")
                    if modified
                    else "Совпадают действие, вид и явно указанная область (демонстрационные правила).",
                    evidence=unique_evidence(
                        old.evidence + [e for f in matches for e in f.evidence]
                    ),
                )
            )
    issues = []
    owner_types = {u.id: u.kind for u in units}
    for index, left in enumerate(after_functions):
        for right in after_functions[index + 1 :]:
            if signatures[left.id] != signatures[right.id]:
                continue
            kind = None
            if left.unit_id != right.unit_id and left.kind == right.kind == "duty":
                # An ancestor/delegate overlap needs semantic interpretation; roles are not
                # enough to assert duplicate departmental responsibilities in offline mode.
                if owner_types[left.unit_id] == owner_types[right.unit_id] == "department":
                    kind = "duplication"
            if (
                left.unit_id == right.unit_id
                and "prohibition" in {left.kind, right.kind}
                and {left.kind, right.kind} & {"duty", "permission"}
            ):
                kind = "conflict"
            if kind:
                issues.append(
                    IssueDraft(
                        kind=kind,
                        function_ids=[left.id, right.id],
                        title=f"Возможное дублирование: {left.action}"
                        if kind == "duplication"
                        else f"Действие противоречит запрету: {left.action}",
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
