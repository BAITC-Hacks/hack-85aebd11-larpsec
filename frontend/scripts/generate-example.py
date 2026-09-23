"""Generate a small, explicitly educational DOCX fixture using only Python's stdlib."""
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

PARAGRAPHS = [
    "УЧЕБНЫЙ ПРИМЕР — ПОЛОЖЕНИЕ О ВНУТРЕННЕМ АУДИТЕ",
    "Демонстрационный документ Larpsec. Это сокращённый учебный пример, а не официальная редакция положения. Он предназначен для проверки загрузки DOCX и просмотра текста.",
    "1. Общие положения",
    "1.1. Блок внутреннего аудита (БВА) осуществляет независимую оценку системы внутреннего контроля и управления рисками.",
    "1.2. Главный аудитор функционально подчиняется Совету директоров. Административное руководство осуществляется Президентом Общества.",
    "3. Структура подразделения",
    "3.4. В состав БВА входят Департамент непрерывного мониторинга системы внутреннего контроля (ДНМ) и Департамент контроля качества аудита и методологии (ДККМ).",
    "5. Права и обязанности",
    "5.4.6. Директор ДНМ анализирует результаты непрерывного аудита и готовит материалы и предложения в зоне ответственности для представления Главному аудитору.",
    "5.5.3. Директор ДККМ готовит отчеты об итогах выполнения плана работы БВА в соответствии с требованиями настоящего Положения.",
    "5.5.4. Директор ДККМ анализирует результаты непрерывного аудита и готовит материалы и предложения в зоне ответственности для представления Главному аудитору.",
    "Примечание: сходство формулировок само по себе не доказывает дублирование функций. Для вывода необходимо учитывать границы ответственности и полный комплект документов.",
]

def main():
    output = Path(__file__).resolve().parents[1] / "public/examples/audit-example.docx"
    output.parent.mkdir(parents=True, exist_ok=True)
    paragraphs = "".join(f'<w:p><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>' for text in PARAGRAPHS)
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/document.xml": f'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>',
    }
    with ZipFile(output, "w") as archive:
        for name, content in files.items():
            info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            archive.writestr(info, content.encode("utf-8"))
    print(output)

if __name__ == "__main__":
    main()
