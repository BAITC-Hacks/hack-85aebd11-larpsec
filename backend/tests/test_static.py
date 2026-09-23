from fastapi.testclient import TestClient

from app import main


def test_frontend_served_without_shadowing_api(settings, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "__file__", str(tmp_path / "backend" / "app" / "main.py"))
    frontend = tmp_path / "frontend" / "dist"
    (frontend / "assets").mkdir(parents=True)
    (frontend / "index.html").write_text("<!doctype html><title>Larpsec</title>")
    (frontend / "assets" / "app.js").write_text("window.loaded = true;")

    with TestClient(main.create_app(settings)) as client:
        response = client.get("/")
        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "Larpsec" in response.text
        assert client.get("/assets/app.js").status_code == 200
        assert client.get("/health").json()["mode"] == "demo"
        assert client.get("/docs").status_code == 200
        assert "openapi" in client.get("/openapi.json").json()
        assert client.post("/api/v1/comparisons", json={}).status_code == 201
        for path in ("/api/v1/missing", "/api/v1/comparisons/missing", "/assets/missing.js"):
            response = client.get(path)
            assert response.status_code == 404
            assert "application/json" in response.headers["content-type"]
            assert "Larpsec" not in response.text


def test_backend_starts_without_frontend_build(settings, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "__file__", str(tmp_path / "backend" / "app" / "main.py"))
    with TestClient(main.create_app(settings)) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/").status_code == 404
