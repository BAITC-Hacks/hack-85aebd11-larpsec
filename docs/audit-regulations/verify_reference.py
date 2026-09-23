#!/usr/bin/env python3
"""Read-only integrity check for the manually reviewed reference, not the service."""

import argparse
import hashlib
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree


def normalize(text):
    return " ".join(text.split())


def require(condition, message):
    if not condition:
        raise ValueError(message)


def extract_units(path, source):
    if source["format"] == "pdf":
        text = subprocess.check_output(
            ["pdftotext", "-layout", str(path), "-"], text=True, encoding="utf-8"
        )
        pages = text.split("\f")
        if pages and not pages[-1].strip():
            pages.pop()
        return [re.sub(r"(?m)^[ \t]*\d+[ \t]*$", "", page) for page in pages]
    require(source["format"] == "docx", "Unsupported reference source format")
    namespaces = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with zipfile.ZipFile(path) as archive:
        root = ElementTree.fromstring(archive.read("word/document.xml"))
    body = root.find("w:body", namespaces)
    require(body is not None, "DOCX has no document body")
    return [
        "".join(node.text or "" for node in paragraph.findall(".//w:t", namespaces))
        for paragraph in body.findall(".//w:p", namespaces)
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", required=True, type=Path)
    args = parser.parse_args()
    reference = Path(__file__).with_name("reference.json")
    data = json.loads(reference.read_text(encoding="utf-8"))
    require(data["schema_version"] == "1.0", "Unsupported reference schema")
    extracted = {}
    for key, source in data["sources"].items():
        path = args.source_dir / source["filename"]
        raw = path.read_bytes()
        require(len(raw) == source["size_bytes"], f"{key}: source size differs")
        require(hashlib.sha256(raw).hexdigest() == source["sha256"],
                f"{key}: source SHA-256 differs")
        extracted[key] = extract_units(path, source)
        count_key = "physical_page_count" if source["format"] == "pdf" else "body_paragraph_count"
        require(len(extracted[key]) == source[count_key], f"{key}: unit count differs")

    for key, item in data["evidence"].items():
        source = item["source"]
        require(source in extracted, f"{key}: unknown source")
        require(key == f"R{data['sources'][source]['revision']}:{item['clause']}",
                f"{key}: evidence key does not match its source/clause")
        locator = item["locator"]
        expected_kind = "pdf_pages" if data["sources"][source]["format"] == "pdf" else "docx_body_paragraphs"
        require(locator["kind"] == expected_kind and locator["index_base"] == 1,
                f"{key}: invalid locator convention")
        start, end = locator["start"], locator["end"]
        require(isinstance(start, int) and isinstance(end, int)
                and 1 <= start <= end <= len(extracted[source]), f"{key}: invalid range")
        quote = item["quote"]
        require(bool(quote) and quote == normalize(quote), f"{key}: invalid quote")
        require(quote.startswith(item["clause"] + "."), f"{key}: wrong clause label")
        actual = normalize("\n".join(extracted[source][start - 1:end]))
        require(quote in actual, f"{key}: quote absent from stated source range")

    seen = set()
    for case in data["cases"]:
        key = case["id"]
        require(key not in seen, f"{key}: duplicate case ID")
        seen.add(key)
        require(case["expected"] and case["forbidden"], f"{key}: incomplete oracle")
        for side in ("before", "after", "absence_checked_in"):
            ids = case.get(side, [])
            require(ids or side == "absence_checked_in", f"{key}: missing {side} evidence")
            for evidence_id in ids:
                require(evidence_id in data["evidence"], f"{key}: unknown {evidence_id}")
                source = data["evidence"][evidence_id]["source"]
                expected_side = "before" if side == "before" else "after"
                require(data["sources"][source]["comparison_side"] == expected_side,
                        f"{key}: wrong comparison side for {evidence_id}")
    print(f"OK: {len(extracted)} sources, {len(seen)} cases, "
          f"{len(data['evidence'])} source quotes. Service evaluation: not run.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile,
            ElementTree.ParseError, subprocess.CalledProcessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
