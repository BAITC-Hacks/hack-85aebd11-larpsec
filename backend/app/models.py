from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Side = Literal["before", "after"]
DocumentFormat = Literal["docx", "pdf", "xlsx", "txt"]
Status = Literal["draft", "queued", "running", "completed", "failed"]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateComparison(Model):
    title: str = Field(default="Анализ реорганизации", min_length=1, max_length=200)
    before_complete: bool = False
    after_complete: bool = False


class CoverageUpdate(Model):
    before_complete: bool
    after_complete: bool


class Problem(Model):
    code: str
    message: str


class Fragment(Model):
    id: str
    document_id: str
    text: str
    locator: str
    clause: str | None = None
    page: int | None = None
    sheet: str | None = None
    cell_range: str | None = None


class Document(Model):
    id: str
    comparison_id: str
    side: Side
    filename: str
    format: DocumentFormat
    sha256: str
    size_bytes: int
    text_chars: int
    fragment_count: int
    warnings: list[str]
    extraction_complete: bool
    created_at: str


class Comparison(Model):
    id: str
    title: str
    before_complete: bool
    after_complete: bool
    status: Status
    stage: str
    progress: int
    mode: Literal["demo", "llm"] | None
    error: Problem | None
    created_at: str
    updated_at: str
    documents: list[Document]


class Evidence(Model):
    fragment_id: str
    quote: str = Field(min_length=1)


class UnitDraft(Model):
    name: str = Field(min_length=1)
    kind: Literal["department", "role", "group"]
    aliases: list[str]
    evidence: list[Evidence] = Field(min_length=1)


class FunctionDraft(Model):
    owner: str = Field(min_length=1)
    action: str = Field(min_length=1)
    object: str
    scope: str
    kind: Literal["duty", "permission", "prohibition"]
    evidence: list[Evidence] = Field(min_length=1)


class ReportingDraft(Model):
    subject: str
    supervisor: str
    kind: Literal["functional", "administrative", "unspecified"]
    evidence: list[Evidence] = Field(min_length=1)


class Extraction(Model):
    units: list[UnitDraft]
    functions: list[FunctionDraft]
    reporting: list[ReportingDraft]
    warnings: list[str]
    complete: bool


class Unit(UnitDraft):
    id: str
    side: Side


class Function(FunctionDraft):
    id: str
    unit_id: str
    side: Side


class Reporting(ReportingDraft):
    side: Side


class UnitLink(Model):
    before_id: str
    after_id: str
    reason: str
    evidence: list[Evidence] = Field(min_length=2)


class FunctionLink(Model):
    before_id: str
    after_ids: list[str] = Field(min_length=1)
    relation: Literal["equivalent", "modified"]
    reason: str
    evidence: list[Evidence] = Field(min_length=2)


class IssueDraft(Model):
    kind: Literal["duplication", "conflict"]
    function_ids: list[str] = Field(min_length=2)
    title: str
    explanation: str
    recommendation: str
    evidence: list[Evidence] = Field(min_length=2)


class AnalysisPlan(Model):
    unit_links: list[UnitLink]
    function_links: list[FunctionLink]
    issues: list[IssueDraft]
    warnings: list[str]


class UnitChange(Model):
    before_ids: list[str]
    after_ids: list[str]
    status: Literal[
        "preserved", "renamed", "merged", "split", "reorganized", "created", "unmatched"
    ]
    explanation: str
    evidence: list[Evidence]


class FunctionChange(Model):
    before_id: str | None
    after_ids: list[str]
    status: Literal["preserved", "moved", "modified", "potential_loss", "unmatched", "added"]
    explanation: str
    evidence: list[Evidence]


class Finding(Model):
    id: str
    kind: Literal["potential_loss", "duplication", "conflict", "coverage_gap", "reporting_change"]
    title: str
    explanation: str
    recommendation: str
    function_ids: list[str]
    evidence: list[Evidence]
    review_required: bool = True


class Review(Model):
    status: Literal["unreviewed", "confirmed", "dismissed"]
    comment: str = Field(default="", max_length=2000)


class ReviewRecord(Review):
    finding_id: str
    updated_at: str


class Result(Model):
    comparison_id: str
    mode: Literal["demo", "llm"]
    model: str | None
    prompt_version: str
    generated_at: str
    units: list[Unit]
    functions: list[Function]
    reporting: list[Reporting]
    unit_changes: list[UnitChange]
    function_changes: list[FunctionChange]
    findings: list[Finding]
    warnings: list[str]
    coverage: dict[str, bool]
    summary: str
    reviews: list[ReviewRecord] = []


class Health(Model):
    status: str
    mode: Literal["demo", "llm"]
    analysis_ready: bool
    version: str
