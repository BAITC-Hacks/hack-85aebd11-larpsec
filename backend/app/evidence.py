import hashlib
import re

from app.errors import AppError
from app.models import Evidence, Fragment


def normalized(text: str) -> str:
    return " ".join(re.findall(r"[\w]+", text.lower().replace("ё", "е")))


def stable_id(prefix: str, *values: str) -> str:
    digest = hashlib.sha256("\x00".join(values).encode()).hexdigest()[:20]
    return f"{prefix}_{digest}"


def unique_evidence(items: list[Evidence]) -> list[Evidence]:
    return list({(e.fragment_id, e.quote): e for e in items}.values())


def validate_evidence(items: list[Evidence], fragments: dict[str, Fragment]) -> None:
    if not items:
        raise AppError("unsupported_evidence", "Ответ содержит утверждение без источника.", 502)
    for evidence in items:
        fragment = fragments.get(evidence.fragment_id)
        if fragment is None or not evidence.quote.strip() or evidence.quote not in fragment.text:
            raise AppError(
                "unsupported_evidence",
                "Ссылка или цитата модели не найдена в исходных фрагментах.",
                502,
            )


def covers(items: list[Evidence], expected: list[Evidence], *, primary_only: bool = False) -> bool:
    """Require the underlying excerpt, not merely a shared heading or paragraph ID."""
    required = expected[:1] if primary_only else expected
    return any(
        supplied.fragment_id == source.fragment_id and source.quote in supplied.quote
        for source in required
        for supplied in items
    )
