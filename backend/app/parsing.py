import codecs
import re
from collections import Counter
from dataclasses import dataclass, field
from io import StringIO
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from docx import Document as WordDocument
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter
from pypdf import PdfReader
from pypdf.generic import ContentStream, StreamObject

from app.config import Settings
from app.errors import AppError
from app.models import Fragment

SUPPORTED = {".docx", ".pdf", ".xlsx", ".txt"}
# A number in prose is not a clause. Prefer explicit markers; bare hierarchical
# labels also need sentence context. Word numbering and Excel № provide context.
CLAUSE = re.compile(r"^\s*(\d{1,3}(?:\.\d{1,3}){0,8})[.)](?=\s|$)")
BARE_CLAUSE = re.compile(r"^\s*(\d{1,3}(?:\.\d{1,3}){1,8})\s+(\S.*)$")
DATE = re.compile(r"^\s*(?:\d{1,2}\.\d{1,2}\.\d{4}|0\d\.(?:0\d|1[0-2])\.\d{2})(?:\D|$)")
QUANTITY = re.compile(
    r"^(?:%|₸|₽|\$|€|кг\b|грамм|мг\b|км\b|метр|мл\b|литр|руб|тенге|доллар|евро|"
    r"тыс\b|млн\b|млрд\b|процент(?:а|ов|ы)?\b|штук|шт\b|человек\b|сотрудник(?:а|ов)?\b|год\b|года\b|лет\b|"
    r"kg\b|km\b|usd\b|eur\b|million\b|billion\b|percent\b|years?\b)",
    re.I,
)
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def supported_suffix(filename: str) -> str:
    return next((suffix for suffix in SUPPORTED if filename.lower().endswith(suffix)), "")


def clause_number(text: str) -> str | None:
    if DATE.match(text):
        return None
    match = CLAUSE.match(text)
    if match:
        return None if QUANTITY.match(text[match.end() :].lstrip()) else match.group(1)
    bare = BARE_CLAUSE.match(text)
    if not bare or QUANTITY.match(bare.group(2)):
        return None
    body = bare.group(2)
    if (
        bare.group(1).count(".") >= 2
        or body[0].isupper()
        or re.match(
            r"^(?:провод|провер|контрол|готов|формир|организ|обеспеч|осуществ|разрабат|утвержд|оцени|анализ|запрещено|вправе|не вправе|имеет право)",
            body,
        )
    ):
        return bare.group(1)
    return None


def labelled_number(value: object) -> str | None:
    """The № column supplies context that a bare decimal in prose does not have."""
    if value is None:
        return None
    text = str(value).strip().rstrip(".)")
    return text if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){0,8}", text) else None


def xml_value(element, child_name: str, default=None):
    child = element.find(W + child_name) if element is not None else None
    return child.get(W + "val", default) if child is not None else default


class WordNumbering:
    """Resolve actual OOXML list labels, including paragraph-style inheritance."""

    def __init__(self, doc):
        self.styles = {s.get(W + "styleId"): s for s in doc.styles.element}
        # numbering_part attempts to create a missing part and can raise
        # NotImplementedError on valid minimal DOCX packages with no lists.
        part = next(
            (
                relation.target_part
                for relation in doc.part.rels.values()
                if relation.reltype == RT.NUMBERING and not relation.is_external
            ),
            None,
        )
        root = part.element if part is not None else None
        self.nums = {} if root is None else {n.get(W + "numId"): n for n in root.findall(W + "num")}
        self.abstracts = (
            {}
            if root is None
            else {n.get(W + "abstractNumId"): n for n in root.findall(W + "abstractNum")}
        )
        self.counters: dict[str, dict[int, int]] = {}

    def properties(self, paragraph):
        properties = [paragraph.find(W + "pPr")]
        style_id = xml_value(properties[0], "pStyle")
        if style_id is None:
            style_id = next(
                (
                    key
                    for key, s in self.styles.items()
                    if s.get(W + "type") == "paragraph" and s.get(W + "default") == "1"
                ),
                None,
            )
        seen = set()
        style_ids = []
        while style_id and style_id not in seen:
            seen.add(style_id)
            style_ids.append(style_id)
            style = self.styles.get(style_id)
            if style is None:
                break
            properties.append(style.find(W + "pPr"))
            style_id = xml_value(style, "basedOn")
        num_id = level = None
        for prop in properties:
            numbering = prop.find(W + "numPr") if prop is not None else None
            if num_id is None:
                num_id = xml_value(numbering, "numId")
            if level is None:
                level = xml_value(numbering, "ilvl")
        return num_id, int(level) if level is not None else None, style_ids

    def levels(self, num_id: str, seen=None):
        seen = set() if seen is None else seen
        if num_id in seen:
            return {}
        seen.add(num_id)
        num = self.nums.get(num_id)
        if num is None:
            return {}
        abstract = self.abstracts.get(xml_value(num, "abstractNumId"))
        if abstract is None:
            return {}
        levels = {int(level.get(W + "ilvl")): level for level in abstract.findall(W + "lvl")}
        linked_style = self.styles.get(xml_value(abstract, "numStyleLink"))
        if linked_style is not None:
            linked_pr = linked_style.find(W + "pPr")
            linked_num = linked_pr.find(W + "numPr") if linked_pr is not None else None
            linked_id = xml_value(linked_num, "numId")
            levels = {**self.levels(linked_id, seen), **levels}
        for override in num.findall(W + "lvlOverride"):
            level = override.find(W + "lvl")
            if level is not None:
                levels[int(override.get(W + "ilvl"))] = level
        return levels

    def start(self, num_id, index, level):
        num = self.nums[num_id]
        for override in num.findall(W + "lvlOverride"):
            if int(override.get(W + "ilvl")) == index:
                start = xml_value(override, "startOverride")
                if start is not None:
                    return int(start)
        return int(xml_value(level, "start", "1"))

    @staticmethod
    def formatted(number: int, kind: str) -> str:
        if kind in {"lowerLetter", "upperLetter"} and number > 0:
            text = ""
            while number:
                number, remainder = divmod(number - 1, 26)
                text = chr(65 + remainder) + text
            return text.lower() if kind == "lowerLetter" else text
        if kind in {"lowerRoman", "upperRoman"} and 0 < number < 4000:
            text = ""
            for value, symbol in (
                (1000, "M"),
                (900, "CM"),
                (500, "D"),
                (400, "CD"),
                (100, "C"),
                (90, "XC"),
                (50, "L"),
                (40, "XL"),
                (10, "X"),
                (9, "IX"),
                (5, "V"),
                (4, "IV"),
                (1, "I"),
            ):
                count, number = divmod(number, value)
                text += symbol * count
            return text.lower() if kind == "lowerRoman" else text
        return f"{number:02d}" if kind == "decimalZero" else str(number)

    def label(self, paragraph) -> tuple[str, str | None, bool]:
        num_id, index, style_ids = self.properties(paragraph)
        if num_id in {None, "0"}:
            return "", None, True
        levels = self.levels(num_id)
        if index is None:
            index = next(
                (
                    level_index
                    for style_id in style_ids
                    for level_index, definition in levels.items()
                    if xml_value(definition, "pStyle") == style_id
                ),
                0,
            )
        if not 0 <= index <= 8:
            return "", None, False
        level = levels.get(index)
        if level is None:
            return "", None, False
        counters = self.counters.setdefault(num_id, {})
        for ancestor in range(index):
            counters.setdefault(ancestor, self.start(num_id, ancestor, levels.get(ancestor)))
        counters[index] = counters.get(index, self.start(num_id, index, level) - 1) + 1
        for descendant in list(counters):
            if descendant <= index:
                continue
            restart = int(xml_value(levels.get(descendant), "lvlRestart", str(descendant)))
            if restart and index < restart:
                del counters[descendant]
        kind = xml_value(level, "numFmt", "decimal")
        template = xml_value(level, "lvlText", f"%{index + 1}.")
        if kind == "none":
            return "", None, True
        if kind == "bullet":
            return "•", None, True
        supported = {
            "decimal",
            "decimalZero",
            "lowerLetter",
            "upperLetter",
            "lowerRoman",
            "upperRoman",
        }
        if kind not in supported:
            return "", None, False

        def replace(match):
            position = int(match.group(1)) - 1
            source = levels.get(position)
            value = counters.get(position, self.start(num_id, position, source))
            return self.formatted(value, xml_value(source, "numFmt", "decimal"))

        label = re.sub(r"%([1-9])", replace, template)
        numeric = label.strip().rstrip(".)")
        clause = numeric if re.fullmatch(r"\d+(?:\.\d+)*", numeric) else None
        return label, clause, True


def pdf_paragraphs(text: str):
    """Join wrapped numbered items while retaining their physical line range."""
    pending = []
    start = end = 0
    for index, raw in enumerate(text.splitlines(), 1):
        line = " ".join(raw.split())
        # Fixed-width PDF extraction may join a separately positioned list label
        # to its first word. Restore that separator before detecting wrapped items.
        line = re.sub(r"^(\d{1,3}(?:\.\d{1,3}){0,8}[.)])(?=[^\W\d_])", r"\1 ", line)
        clause = clause_number(line)
        numbered = clause is not None
        body = re.sub(r"^" + re.escape(clause) + r"[.)]?\s*", "", line) if clause else line
        bullet = bool(re.match(r"^(?:[a-zа-я][.)]\s|[-–—•·*●▪]\s*)", body, re.I))
        heading = bool(
            re.match(
                r"^(?:(?:Подразделение|Должность|Группа|(?:Функциональное |Административное )?подчинение)\s*:|"
                r"(?:переименован[аоы]?\s+из|прежнее\s+наименование|ранее)\s*:|"
                r"положение(?:\s+(?:об|о)\s+|$)|(?:функции|обязанности)\s+)",
                body,
                re.I,
            )
            or re.fullmatch(
                r"(?:общие положения|основные задачи|задачи|функции|права|обязанности|ответственность|заключительные положения)[.:]?",
                body,
                re.I,
            )
            or body.endswith(":")
        )
        boundary = bool(not line or numbered or bullet or heading or line.isdigit())
        if pending and boundary:
            yield " ".join(pending), start, end
            pending = []
        if not line:
            continue
        if heading:
            yield line, index, index
            continue
        if numbered or bullet or pending:
            if not pending:
                start = index
            pending.append(line)
            end = index
        else:
            yield line, index, index
    if pending:
        yield " ".join(pending), start, end


TABLE_HEADERS = {
    "number": {"№", "№ п/п", "номер", "пункт", "номер пункта", "no", "number"},
    "department": {
        "подразделение",
        "наименование подразделения",
        "департамент",
        "отдел",
        "department",
        "unit",
    },
    "role": {"должность", "наименование должности", "role"},
    "group": {"группа", "group"},
    "function": {
        "функция",
        "функции",
        "обязанность",
        "обязанности",
        "описание функции",
        "функционал",
        "function",
        "responsibility",
    },
    "scope": {"область", "область ответственности", "зона ответственности", "scope"},
    "kind": {"тип", "тип функции", "тип нормы", "вид функции", "kind"},
}


def table_header(cells):
    found = {}
    duplicate = False
    for cell in cells:
        value = " ".join(str(cell.value).lower().replace("ё", "е").strip().rstrip(":.").split())
        key = next((key for key, names in TABLE_HEADERS.items() if value in names), None)
        if key:
            duplicate |= key in found or (
                key in {"department", "role", "group"}
                and bool(set(found) & {"department", "role", "group"})
            )
            found[key] = cell.column
    return found if "function" in found and not duplicate else None


@dataclass
class Parsed:
    fragments: list[Fragment] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    complete: bool = True


def word_text(paragraph) -> str:
    """Preserve Word's explicit separators without duplicating nested text boxes."""
    parts = []

    def visit(node):
        for child in node:
            if child.tag == W + "p":
                continue  # Nested paragraphs have their own locator in the caller.
            if child.tag == W + "t":
                parts.append(child.text or "")
            elif child.tag in {W + "br", W + "cr"}:
                parts.append("\n")
            elif child.tag == W + "tab":
                parts.append("\t")
            else:
                visit(child)

    visit(paragraph)
    return "".join(parts)


def pdf_has_images(page, reader) -> bool:
    """Inspect image/form resources and inline operators without decoding bitmap data."""
    visited = set()

    def visit(node):
        node = node.get_object()
        if id(node) in visited:
            return False
        visited.add(id(node))
        if node.get("/Subtype") == "/Image":
            return True
        stream = (
            ContentStream(node, reader) if isinstance(node, StreamObject) else node.get_contents()
        )
        if stream is not None:
            if len(stream.get_data()) > 20 * 1024**2:
                raise AppError("page_too_large", "Содержимое страницы PDF превышает лимит.", 413)
            if any(operator == b"INLINE IMAGE" for _, operator in stream.operations):
                return True
        resources = node.get("/Resources")
        if resources is None:
            return False
        objects = resources.get_object().get("/XObject")
        return objects is not None and any(visit(obj) for obj in objects.get_object().values())

    return visit(page)


def pdf_has_forms(page) -> bool:
    # pypdf layout extraction does not visit Form XObjects. Even a page with a
    # nonempty layout result may have its main text inside an embedded form.
    resources = page.get("/Resources")
    if resources is None:
        return False
    objects = resources.get_object().get("/XObject")
    return objects is not None and any(
        obj.get_object().get("/Subtype") == "/Form" for obj in objects.get_object().values()
    )


def check_office_archive(path: Path) -> None:
    try:
        with ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > 10000 or sum(x.file_size for x in entries) > 100 * 1024**2:
                raise AppError(
                    "archive_too_large", "Распакованный документ превышает 100 МБ или 10000 файлов."
                )
            if any(x.flag_bits & 1 for x in entries):
                raise AppError("encrypted_file", "Зашифрованные документы не поддерживаются.")
    except BadZipFile as exc:
        raise AppError(
            "invalid_document", "Файл не является корректным документом Office."
        ) from exc


def decode_plain_text(data: bytes) -> tuple[str, str | None]:
    # Do not reinterpret a renamed document or binary container as legacy text.
    binary_headers = (
        b"%PDF-",
        b"PK\x03\x04",
        b"PK\x05\x06",
        b"PK\x07\x08",
        b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",
        b"\x89PNG\r\n\x1a\n",
        b"\xff\xd8\xff",
        b"GIF87a",
        b"GIF89a",
        b"\x1f\x8b",
        b"7z\xbc\xaf\x27\x1c",
        b"Rar!\x1a\x07",
        b"\x7fELF",
    )
    if data.lstrip(b" \t\r\n").startswith(binary_headers):
        raise AppError(
            "invalid_document",
            "Содержимое TXT не является обычным текстом. Загрузите документ с исходным расширением или сохраните его как текст UTF-8.",
        )
    warning = None
    encoding = None
    # UTF-32 LE shares its first two bytes with UTF-16 LE, so check it first.
    for markers, candidate in (
        ((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE), "utf-32"),
        ((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE), "utf-16"),
        ((codecs.BOM_UTF8,), "utf-8-sig"),
    ):
        if data.startswith(markers):
            encoding = candidate
            break
    try:
        if encoding:
            # A declared Unicode encoding must decode strictly. Falling back to
            # Windows-1251 here would silently disguise a damaged Unicode file.
            text = data.decode(encoding)
        else:
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError as exc:
                # A valid non-ASCII UTF-8 prefix followed by damaged bytes is
                # ambiguous; require a clean export instead of inventing text.
                if any(value >= 128 for value in data[: exc.start]):
                    raise
                text = data.decode("cp1251")
                words = re.findall(r"[A-Za-zА-Яа-яЁё]+", text)
                russian = [word for word in words if re.search(r"[А-Яа-яЁё]", word)]
                letters = "".join(russian)
                mixed_script = any(re.search(r"[A-Za-z]", word) for word in russian)
                mixed_case = any(
                    sum(c.isupper() for c in word[1:]) > len(word) / 4
                    for word in russian
                    if not word.isupper()
                )
                vowel_ratio = sum(c.lower() in "аеёиоуыэюя" for c in letters) / max(1, len(letters))
                foreign_cyrillic = re.search(r"[Ѐ-Џђ-џ]", text)
                if (
                    not letters
                    or mixed_script
                    or mixed_case
                    or foreign_cyrillic
                    or vowel_ratio < 0.2
                ):
                    raise AppError(
                        "invalid_document",
                        "Кодировка TXT неоднозначна: текст не похож на Windows-1251. Сохраните исходный файл в UTF-8 и загрузите заново.",
                    ) from exc
                warning = "TXT прочитан как Windows-1251. Проверьте отображение букв; если оно неверное, сохраните исходный файл в UTF-8 и загрузите заново."
    except UnicodeError as exc:
        raise AppError(
            "invalid_document",
            "Не удалось определить кодировку TXT или файл повреждён. Сохраните исходный текст в UTF-8 и загрузите заново.",
        ) from exc
    # Line breaks, tabs and form feeds are meaningful plain text separators.
    # Other C0/C1 controls (including NUL) indicate binary or damaged input.
    if re.search(r"[\x00-\x08\x0b\x0e-\x1f\x7f-\x9f]", text):
        raise AppError(
            "invalid_document",
            "TXT содержит бинарные данные или недопустимые управляющие символы. Сохраните файл как обычный текст UTF-8.",
        )
    return text, warning


def parse_document(path: Path, document_id: str, settings: Settings) -> Parsed:
    suffix = supported_suffix(path.name)
    if suffix not in SUPPORTED:
        raise AppError("unsupported_format", "Поддерживаются DOCX, PDF, XLSX и TXT.", 415)
    result = Parsed()
    total_chars = 0

    def add(text: str, locator: str, *, clause: str | None = None, **extra: object) -> None:
        nonlocal total_chars
        text = text.replace("\x00", "").strip()
        if not text:
            return
        if re.fullmatch(r"\d+(?:\.\d+)+\.?\s*[;:–—-]?", text):
            result.warnings.append(
                f"{locator}: пустой нумерованный пункт «{text}»; это не доказательство потери функции."
            )
        total_chars += len(text)
        if total_chars > settings.max_document_chars:
            raise AppError(
                "document_too_long",
                "В документе слишком много текста; разделите его на части.",
                413,
            )
        # Keep fragments bounded for extraction prompts, never discard the tail.
        for start in range(0, len(text), 6000):
            part = text[start : start + 6000]
            result.fragments.append(
                Fragment(
                    id=f"{document_id}:{len(result.fragments) + 1:05d}",
                    document_id=document_id,
                    text=part,
                    locator=locator + (f", часть {start // 6000 + 1}" if len(text) > 6000 else ""),
                    clause=clause if clause is not None else clause_number(text),
                    **extra,
                )
            )

    try:
        if suffix in {".docx", ".xlsx"}:
            check_office_archive(path)
        if suffix == ".docx":
            doc = WordDocument(path)
            numbering = WordNumbering(doc)

            def add_paragraph(paragraph, locator, numbering):
                label, clause, complete = numbering.label(paragraph)
                if not complete:
                    result.complete = False
                    result.warnings.append(
                        f"{locator}: не удалось восстановить автоматическую нумерацию Word."
                    )
                lines = word_text(paragraph).splitlines()
                if label:
                    lines = lines or [""]
                    lines[0] = f"{label} {lines[0]}".rstrip()
                for number, line in enumerate(lines, 1):
                    add(
                        line,
                        locator + (f", строка {number}" if len(lines) > 1 else ""),
                        clause=clause,
                    )

            for index, paragraph in enumerate(doc.element.body.iter(W + "p"), 1):
                add_paragraph(paragraph, f"Абзац {index} (включая таблицы)", numbering)
            seen_parts = set()
            for section_index, section in enumerate(doc.sections, 1):
                parts = (
                    (section.header, "Верхний колонтитул"),
                    (section.footer, "Нижний колонтитул"),
                    (section.first_page_header, "Верхний колонтитул первой страницы"),
                    (section.first_page_footer, "Нижний колонтитул первой страницы"),
                    (section.even_page_header, "Верхний колонтитул чётных страниц"),
                    (section.even_page_footer, "Нижний колонтитул чётных страниц"),
                )
                for part, title in parts:
                    if part.part.partname in seen_parts:
                        continue
                    seen_parts.add(part.part.partname)
                    part_numbering = WordNumbering(doc)
                    for index, p in enumerate(part._element.iter(W + "p"), 1):
                        add_paragraph(
                            p,
                            f"{title}, раздел {section_index}, абзац {index}",
                            part_numbering,
                        )
            if doc.element.body.xpath(".//w:drawing | .//w:pict | .//w:object"):
                result.complete = False
                result.warnings.append(
                    "Есть рисунки или вложенные объекты: их содержимое не распознано; требуется проверка/OCR."
                )
            if doc.element.body.xpath(".//w:ins | .//w:del"):
                result.complete = False
                result.warnings.append(
                    "Обнаружены исправления Word: загрузите редакцию с принятыми изменениями."
                )
        elif suffix == ".pdf":
            reader = PdfReader(path)
            if reader.is_encrypted:
                raise AppError("encrypted_file", "Снимите пароль с PDF перед загрузкой.")
            if len(reader.pages) > 300:
                raise AppError("too_many_pages", "Допускается не более 300 страниц PDF.", 413)
            for page_number, page in enumerate(reader.pages, 1):
                content = page.get_contents()
                if content is not None and len(content.get_data()) > 20 * 1024**2:
                    raise AppError(
                        "page_too_large", "Содержимое страницы PDF превышает лимит.", 413
                    )
                text = ""
                if content is not None:
                    try:
                        # Group words by their page positions, including rotated
                        # text; retain vertical gaps for paragraph boundaries.
                        # Form XObjects require the plain extractor to retain text.
                        if not pdf_has_forms(page):
                            text = (
                                page.extract_text(
                                    extraction_mode="layout",
                                    layout_mode_space_vertically=True,
                                    layout_mode_strip_rotated=False,
                                )
                                or ""
                            )
                    except Exception:
                        # Some PDF fonts/layouts cannot be handled geometrically.
                        # The plain extractor may still recover useful evidence.
                        text = ""
                    if text.strip():
                        try:
                            plain = page.extract_text() or ""
                            # Geometry may legitimately reorder the content stream.
                            # Compare character counts, not sequence, to detect lost
                            # evidence without undoing the recovered reading order.
                            if Counter(re.sub(r"\s", "", text)) != Counter(
                                re.sub(r"\s", "", plain)
                            ):
                                text = plain if plain.strip() else text
                                result.complete = False
                                result.warnings.append(
                                    f"Страница {page_number}: способы извлечения текста расходятся; проверьте полноту и порядок слов по оригиналу."
                                )
                        except Exception:
                            result.complete = False
                            result.warnings.append(
                                f"Страница {page_number}: полноту геометрического извлечения текста не удалось проверить; сверьте с оригиналом."
                            )
                    if not text.strip():
                        text = page.extract_text() or ""
                        if text.strip():
                            result.complete = False
                            result.warnings.append(
                                f"Страница {page_number}: текст извлечён без сохранения расположения строк; проверьте порядок слов по оригиналу."
                            )
                if pdf_has_images(page, reader):
                    result.complete = False
                    result.warnings.append(
                        f"Страница {page_number}: есть изображение; часть содержимого может требовать OCR даже при наличии текстового слоя."
                    )
                if len(text.strip()) < 10:
                    result.complete = False
                    result.warnings.append(
                        f"Страница {page_number}: недостаточно текста; возможен скан, требуется OCR."
                    )
                for paragraph, start, end in pdf_paragraphs(text):
                    locator = (
                        f"Страница {page_number}, строка {start}"
                        if start == end
                        else f"Страница {page_number}, строки {start}–{end}"
                    )
                    add(paragraph, locator, page=page_number)
        elif suffix == ".xlsx":
            book = load_workbook(path, read_only=True, data_only=False, keep_links=False)
            try:
                for sheet in book.worksheets:
                    if (sheet.max_row or 0) > 50000 or (sheet.max_column or 0) > 200:
                        raise AppError(
                            "sheet_too_large", "Лист превышает 50000 строк или 200 столбцов.", 413
                        )
                    count = 0
                    has_formulas = False
                    columns = None
                    column_names = {}
                    current_owner = None
                    sheet_warnings = set()

                    def warn(message, seen=sheet_warnings, title=sheet.title):
                        result.complete = False
                        if message not in seen:
                            seen.add(message)
                            result.warnings.append(f"Лист «{title}»: {message}")

                    for row in sheet.iter_rows():
                        count += len(row)
                        if count > 200000:
                            raise AppError("sheet_too_large", "Лист превышает 200000 ячеек.", 413)
                        cells = [c for c in row if c.value is not None]
                        if not cells:
                            continue
                        has_formulas |= any(c.data_type == "f" for c in cells)
                        cell_range = f"{get_column_letter(cells[0].column)}{cells[0].row}:{get_column_letter(cells[-1].column)}{cells[-1].row}"
                        locator = f"Лист «{sheet.title}», {cell_range}"
                        metadata = {"sheet": sheet.title, "cell_range": cell_range}
                        raw_text = " | ".join(str(c.value) for c in cells)
                        header = table_header(cells)
                        if header is not None:
                            if header != columns:
                                current_owner = None
                            columns = header
                            column_names = {c.column: str(c.value) for c in cells}
                            add(raw_text, locator, **metadata)
                            continue
                        if columns is None:
                            add(raw_text, locator, **metadata)
                            if len(cells) > 1:
                                warn(
                                    "заголовки таблицы не распознаны; принадлежность функций и полнота извлечения не подтверждены."
                                )
                            continue
                        values = {c.column: c for c in cells}

                        def value(key, values=values, columns=columns):
                            cell = values.get(columns.get(key))
                            return str(cell.value).strip() if cell is not None else ""

                        owner_key = next(
                            (key for key in ("department", "role", "group") if key in columns), None
                        )
                        owner = value(owner_key) if owner_key else ""
                        if owner:
                            label = {
                                "department": "Подразделение",
                                "role": "Должность",
                                "group": "Группа",
                            }[owner_key]
                            declared = f"{label}: {owner}"
                            if current_owner != declared:
                                owner_cell = values[columns[owner_key]]
                                add(
                                    declared,
                                    f"Лист «{sheet.title}», {owner_cell.coordinate}",
                                    sheet=sheet.title,
                                    cell_range=owner_cell.coordinate,
                                )
                                current_owner = declared
                        if not current_owner:
                            warn(
                                "в табличной функции не указан владелец; проверьте колонку подразделения или должности."
                            )
                        function = value("function")
                        if not function:
                            add(raw_text, locator, **metadata)
                            warn(
                                "строка таблицы не содержит текста функции; содержимое сохранено без интерпретации."
                            )
                            continue
                        number = labelled_number(value("number"))
                        if value("number") and number is None:
                            warn(
                                "номер пункта в колонке № не распознан; исходное значение сохранено в тексте строки."
                            )
                        kind = value("kind").lower()
                        if kind in {"запрет", "запрещено", "prohibition"} and not re.match(
                            r"^(?:запрещено|не вправе|не имеет права|не имеют права)\b",
                            function,
                            re.I,
                        ):
                            function = f"Запрещено: {function}"
                        elif kind in {"право", "permission"} and not re.match(
                            r"^(?:вправе|имеет право|имеют право)\b", function, re.I
                        ):
                            function = f"Вправе: {function}"
                        elif kind and kind not in {
                            "обязанность",
                            "функция",
                            "duty",
                            "запрет",
                            "запрещено",
                            "prohibition",
                            "право",
                            "permission",
                        }:
                            warn(
                                "тип функции не распознан; проверьте обязанность, право или запрет."
                            )
                        if number and clause_number(function) != number:
                            function = f"{number}. {function}"
                        if scope := value("scope"):
                            function += f"; Область: {scope}"
                        add(function, locator, clause=number, **metadata)
                        extras = [
                            f"{column_names.get(c.column, 'Значение')}: {c.value}"
                            for c in cells
                            if c.column not in columns.values()
                            or (c.column == columns.get("number") and number is None)
                            or c.column == columns.get("kind")
                        ]
                        if extras:
                            add(" | ".join(extras), locator, **metadata)
                    if has_formulas:
                        result.complete = False
                        result.warnings.append(
                            f"Лист «{sheet.title}»: формулы сохранены как текст, вычисления не выполнялись."
                        )
                with ZipFile(path) as archive:
                    if any(n.startswith(("xl/drawings/", "xl/media/")) for n in archive.namelist()):
                        result.complete = False
                        result.warnings.append(
                            "В Excel есть графические объекты, их содержимое требует отдельной проверки."
                        )
            finally:
                book.close()
        elif suffix == ".txt":
            byte_limit = settings.max_upload_mb * 1024**2
            with path.open("rb") as source:
                data = source.read(byte_limit + 1)
            if len(data) > byte_limit:
                raise AppError("upload_too_large", "Файл превышает допустимый размер.", 413)
            text, warning = decode_plain_text(data)
            if warning:
                result.warnings.append(warning)
            # Preserve physical source line numbers, including skipped empty
            # lines, so citations point back to the original TXT accurately.
            with StringIO(text, newline=None) as lines:
                for index, line in enumerate(lines, 1):
                    add(line, f"Строка {index}")
    except AppError:
        raise
    except Exception as exc:
        raise AppError(
            "invalid_document",
            "Не удалось прочитать документ: проверьте формат и целостность файла.",
        ) from exc
    if not result.fragments:
        if suffix == ".txt":
            raise AppError("no_text", "Файл TXT пуст или содержит только пробелы и переносы строк.")
        raise AppError("no_text", "Текст не найден. Для сканов сначала выполните OCR.")
    return result
