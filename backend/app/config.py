from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    analysis_mode: Literal["demo", "llm"] = "demo"
    llm_api_key: SecretStr = SecretStr("")
    llm_model: str = ""
    llm_base_url: str = "https://api.openai.com/v1"
    llm_timeout_seconds: float = Field(default=120, gt=0, le=600)
    llm_max_output_tokens: int = Field(default=16000, ge=1000)
    data_dir: Path = Path("data")
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]
    api_token: SecretStr = SecretStr("")
    max_upload_mb: int = Field(default=20, ge=1, le=100)
    max_documents: int = Field(default=20, ge=2, le=100)
    max_document_chars: int = Field(default=200000, ge=1000)
    max_comparison_chars: int = Field(default=400000, ge=1000)
    max_analysis_functions: int = Field(default=1000, ge=10)
    max_llm_input_chars: int = Field(default=300000, ge=10000)
    extraction_chunk_chars: int = Field(default=12000, ge=2000)
    job_workers: int = Field(default=2, ge=1, le=8)
    max_pending_jobs: int = Field(default=10, ge=1, le=100)

    @property
    def llm_ready(self) -> bool:
        return bool(self.llm_api_key.get_secret_value() and self.llm_model.strip())
