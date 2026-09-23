"""Run a reproducible API demonstration against a running local backend."""

import argparse
import os
import time
from pathlib import Path

import httpx

from scripts.make_demo import make_demo


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--directory", type=Path, default=Path("data/demo"))
    parser.add_argument("--timeout", type=float, default=600)
    args = parser.parse_args()
    make_demo(args.directory)
    headers = (
        {"Authorization": f"Bearer {os.environ['API_TOKEN']}"} if os.getenv("API_TOKEN") else {}
    )
    with httpx.Client(base_url=args.url.rstrip("/"), headers=headers, timeout=60) as client:
        response = client.post(
            "/api/v1/comparisons",
            json={
                "title": "Учебная реорганизация БВА",
                "before_complete": True,
                "after_complete": True,
            },
        )
        response.raise_for_status()
        cid = response.json()["id"]
        for side in ("before", "after"):
            path = args.directory / f"{side}.docx"
            with path.open("rb") as source:
                response = client.post(
                    f"/api/v1/comparisons/{cid}/documents",
                    params={"side": side},
                    files={"file": (path.name, source)},
                )
                response.raise_for_status()
        response = client.post(f"/api/v1/comparisons/{cid}/analyze")
        response.raise_for_status()
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            response = client.get(f"/api/v1/comparisons/{cid}")
            response.raise_for_status()
            state = response.json()
            if state["status"] == "failed":
                raise SystemExit(f"Анализ завершился ошибкой: {state['error']}")
            if state["status"] == "completed":
                break
            time.sleep(0.5)
        else:
            raise SystemExit(f"Время ожидания истекло. Сравнение: {cid}")
        response = client.get(f"/api/v1/comparisons/{cid}/result")
        response.raise_for_status()
        result = response.json()
        (args.directory / "result.json").write_text(response.text)
        report = client.get(f"/api/v1/comparisons/{cid}/report")
        report.raise_for_status()
        (args.directory / "report.md").write_text(report.text)
        print(result["summary"])
        print(
            f"Сравнение: {cid}\nРезультат: {args.directory / 'result.json'}\nОтчёт: {args.directory / 'report.md'}"
        )


if __name__ == "__main__":
    main()
