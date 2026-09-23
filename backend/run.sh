#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
uv sync --frozen --no-dev
exec uv run --frozen --no-dev uvicorn app.main:app --host 127.0.0.1 --port "${PORT:-8000}" --workers 1
