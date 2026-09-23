import time

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from scripts.make_demo import make_demo


@pytest.fixture
def settings(tmp_path):
    return Settings(_env_file=None, data_dir=tmp_path / "storage", analysis_mode="demo")


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as client:
        yield client


@pytest.fixture
def demo_files(tmp_path):
    directory = tmp_path / "demo"
    make_demo(directory)
    return directory


def upload(client, cid, path, side):
    with path.open("rb") as source:
        return client.post(
            f"/api/v1/comparisons/{cid}/documents",
            params={"side": side},
            files={"file": (path.name, source)},
        )


def prepare(client, directory, complete=True):
    response = client.post(
        "/api/v1/comparisons",
        json={"title": "Учебная проверка", "before_complete": complete, "after_complete": complete},
    )
    assert response.status_code == 201, response.text
    cid = response.json()["id"]
    for side in ("before", "after"):
        response = upload(client, cid, directory / f"{side}.docx", side)
        assert response.status_code == 201, response.text
    return cid


def analyze(client, cid):
    response = client.post(f"/api/v1/comparisons/{cid}/analyze")
    assert response.status_code == 202, response.text
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        state = client.get(f"/api/v1/comparisons/{cid}").json()
        if state["status"] in {"completed", "failed"}:
            assert state["status"] == "completed", state
            return client.get(f"/api/v1/comparisons/{cid}/result").json()
        time.sleep(0.01)
    pytest.fail("Background analysis timed out")
