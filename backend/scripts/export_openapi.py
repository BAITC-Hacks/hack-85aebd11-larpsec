import json
from pathlib import Path

from app.main import create_app

if __name__ == "__main__":
    destination = Path(__file__).resolve().parents[2] / "docs" / "openapi.json"
    destination.write_text(json.dumps(create_app().openapi(), ensure_ascii=False, indent=2) + "\n")
    print(destination)
