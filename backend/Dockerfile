# Build from the repository root: docker build -f backend/Dockerfile .
FROM node:22-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN npx --yes pnpm@10.30.3 install --frozen-lockfile
COPY frontend/ ./
RUN npx --yes pnpm@10.30.3 build

FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.7 /uv /uvx /bin/
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev
COPY backend/app ./app
COPY --from=frontend /build/frontend/dist /app/frontend/dist
RUN useradd --create-home appuser && mkdir /app/data && chown appuser:appuser /app/data
ENV DATA_DIR=/app/data
USER appuser
EXPOSE 8000
CMD [".venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
