# Исправления по QA, пункты 1–31

Карта замечаний связывает изменения с регрессионными проверками. Наличие теста
означает проверку указанного сценария, а не гарантию распознавания любой формулировки.
Результаты общего прогона приведены в конце файла и в VALIDATION.md.

Обозначения файлов в таблице:

- **A** — [анализ и сопоставление](../backend/tests/test_qa_analysis.py).
- **P** — [парсеры DOCX, PDF и XLSX](../backend/tests/test_qa_parsing.py).
- **R** — [API, удаление и отчёты](../backend/tests/test_qa_api_reports.py).
- **F** — [интерфейс и сравнение текста](../frontend/tests/unit/qa-regressions.test.ts).

| № | Что исправлено | Регрессионная проверка |
| --- | --- | --- |
| 1 | Нумерованные функции не ограничены коротким словарём глаголов. Словарь ненумерованных действий расширен; нераспознанный текст внутри блока владельца снижает полноту. | A: `test_qa01_numbered_unfamiliar_verbs_are_not_silently_lost`, `test_qa01_expanded_unnumbered_verbs`, `test_qa01_unrecognized_owner_block_prose_marks_incomplete` |
| 2 | Маркеры списков удаляются из действия. Возможные функции до первого владельца дают предупреждение и неполное покрытие. | A: `test_qa02_bulleted_function_is_extracted_without_marker`, `test_qa02_function_before_first_owner_disables_complete_coverage` |
| 3 | Распознаются формы «Переименован/переименована/переименовано/переименованы из», «Ранее», «Прежнее наименование». | A: `test_qa03_31_renamed_unit_keeps_its_functions` |
| 4 | Точное текущее имя владельца имеет приоритет перед совпадением с прежним названием другого субъекта. | A: `test_qa04_exact_owner_name_takes_precedence_over_another_unit_alias` |
| 5 | Сопоставление учитывает основные окончания первого глагола. У одного владельца проверяются пары обязанность/запрет и право/запрет; разная область ответственности не объявляется конфликтом. | A: `test_qa05_conflicts_use_verb_inflection_and_rights`, `test_qa05_different_scope_is_not_a_conflict` |
| 6 | Изменение функционального и административного подчинения выводится отдельно с источниками. Переименование руководителя и наличие его отдельного описания только с одной стороны не создают ложного изменения. | A: `test_qa06_reporting_change_includes_both_sources`, `test_qa06_renamed_subject_and_supervisor_do_not_fake_reporting_change`, `test_qa06_reporting_only_documents_still_compare_subjects`, `test_qa06_same_supervisor_declared_as_unit_on_one_side_is_unchanged`; F: `renders reporting changes without inventing function associations` |
| 7 | Изменённая область либо вид нормы при том же действии дают «Изменена» с объяснением различий. | A: `test_qa07_changed_scope_or_kind_is_modified` |
| 8 | Поддержаны заголовки положений и функций, в том числе отдельные строки заголовка. Конкретный новый заголовок переключает владельца. Нераспознанная структура возвращает результат с предупреждением; имена должностей не привязаны к организатору. | A: `test_qa08_standard_regulation_heading_without_magic_prefix`, `test_qa08_multiple_function_headings_switch_owners`, `test_qa08_heading_cases_do_not_create_a_second_owner`, `test_qa08_unstructured_text_returns_result_and_explicit_warning`, `test_qa08_generic_subject_rights_header_has_no_organizer_specific_names` |
| 9 | XLSX с заголовками «№ / подразделение / функция» разбирается по смыслу колонок. Сохраняются владелец, пункт, вид нормы и исходные координаты; неоднозначная таблица помечается неполной. | P: `test_xlsx_header_table_emits_owned_functions_without_cell_addresses`, `test_xlsx_owner_kind_and_norm_are_preserved`, `test_xlsx_ambiguous_structure_keeps_values_and_marks_incomplete` |
| 10 | Перенесённые строки нумерованных и маркированных пунктов PDF соединяются; заголовки и вертикальные интервалы сохраняют границы. Изменение окончания русского пункта проверено через загрузку и анализ: оно не помечается сохранённым. Источник хранит страницу и диапазон строк. | P: `test_pdf_wrapped_numbered_paragraphs_keep_full_action_and_line_locator`, `test_pdf_structural_headings_are_not_swallowed_by_previous_function`, `test_pdf_bullets_start_a_new_function_and_keep_their_wrapped_tail`, `test_pdf_vertical_gap_separates_paragraph_without_splitting_indented_wrap`, `test_russian_pdf_changed_wrapped_tail_is_not_reported_as_preserved` |
| 11 | Несвязанные удалённые и добавленные строки не становятся «изменёнными» только из-за соседнего положения. Для пары требуется достаточное совпадение значимых слов. | F: `keeps unrelated removals and additions separate`, `requires at least half of meaningful tokens and more than one common token`, `does not pair positional neighbors when a later line is the meaningful match` |
| 12 | Сдвиг адресов ячеек XLSX не создаёт текстовое изменение; исходные координаты остаются доступны в источниках. | F: `ignores shifted legacy XLSX cell coordinates while retaining cell values`, `preserves spreadsheet addresses in source locators`; P: `test_xlsx_header_table_emits_owned_functions_without_cell_addresses` |
| 13 | Изменённые строки имеют отдельный счётчик и не учитываются одновременно как удалённые и добавленные. | F: `counts changed lines separately instead of double-counting removed/added` |
| 14 | Даты, годы и количества отделены от пунктов. Восстановлена настоящая нумерация Word, включая уровни, перезапуски, переопределения и наследование стилей. Минимальный DOCX без numbering.xml продолжает читаться и загружаться. | P: `test_numbers_in_prose_are_not_clause_references`, `test_explicit_clause_markers_are_recognized`, `test_docx_real_numbering_multilevel_restart_and_override`, `test_docx_numbering_is_inherited_from_style_chain`, `test_docx_style_level_is_resolved_from_numbering_definition`, `test_docx_builtin_numbered_style_and_unknown_definition`, `test_existing_public_docx_without_numbering_part_still_parses_and_uploads` |
| 15 | Карточки замечаний показывают связанные функции, владельцев и вид нормы. Заголовок потери уточняет, какая функция затронута. | F: `renders associated owners, actions and prohibition labels directly on finding cards`; A: `test_qa01_numbered_unfamiliar_verbs_are_not_silently_lost`, `test_qa15_conflict_title_names_action_once` |
| 16 | Добавлены история и удаление сравнения. Удаляются файлы, документы, результат и оценки; выполняющееся сравнение защищено от удаления. Параллельное удаление не ломает список истории. | R: `test_delete_completed_comparison_cascades_and_removes_uploads`, `test_delete_active_comparison_rejected_without_mutation`, `test_delete_and_queue_are_serialized`, `test_delete_rolls_back_moved_files_if_filesystem_operation_fails`, `test_history_skips_comparison_deleted_after_id_query`; F: `lists server history with pagination and deletes the selected comparison`, `surfaces rejection if analysis started before deletion` |
| 17 | Markdown использует русские режимы, статусы, стороны и оценки, читаемые даты с часовым поясом. Пустые поля функций не создают лишних точек с запятой; кавычки сохраняются. | R: `test_markdown_is_russian_readable_and_preserves_quotes` |
| 18 | JSON-отчёт содержит название сравнения, метаданные документов и SHA-256, полный текст источников и координаты каждой цитаты. Компактный `/result` сохранён. | R: `test_json_export_is_self_contained_and_result_contract_stays_compact` |
| 19 | Сводка сообщает «Найдено подразделений и должностей»; число извлечённых субъектов не выдаётся за число соответствий. | A: `test_qa19_summary_describes_extracted_counts` |
| 20 | Исправлено склонение количества документов: 1 документ, 2 документа, 5 документов и т. д. | F: `declines document count %s` |
| 21 | Выбранные раздел и вкладка сохраняются; устаревшие значения и недоступное хранилище обрабатываются безопасно. | F: `restores chosen page and tab, rejects obsolete values and tolerates disabled storage` |
| 22 | Боковая панель занимает высоту окна; её фон продолжается до конца длинной страницы. | F: `keeps the sidebar viewport height and extends its rail to the document bottom` |
| 23 | Неполное извлечение и предупреждения показываются в баннере документа вместо безусловного «Готово». | F: `shows partial extraction and warnings instead of an unconditional success banner` |
| 24 | Учебная пара загружается с русскими именами «Положение — до изменений.docx» и «Положение — после изменений.docx». | F: `uses Russian sample filenames and analysis-specific page descriptions` |
| 25 | Подзаголовок страницы анализа описывает функции, подразделения и подчинённость; подзаголовки документов и текстового сравнения остаются отдельными. | F: `uses Russian sample filenames and analysis-specific page descriptions` |
| 26 | Явно указанная группа сохраняет тип `group`, а не превращается в подразделение. | A: `test_qa26_group_is_distinct_from_department`; P: `test_xlsx_owner_kind_and_norm_are_preserved` |
| 27 | Источники в колонтитулах Word имеют понятные названия с разделом и абзацем вместо внутренних XML-путей. | P: `test_docx_headers_and_footers_use_friendly_section_locators` |
| 28 | Файл с именем ровно `.docx` проходит ту же проверку формата, что и обычное имя. Повреждённые файлы не меняют сравнение и не остаются в хранилище. | P: `test_extension_only_docx_name_can_be_parsed_and_uploaded`, `test_malformed_upload_keeps_comparison_and_storage_unchanged`; R: `test_hidden_docx_filename_uploads_normally` |
| 29 | Замечания фильтруются по типу и решению эксперта; карточки сводки включают соответствующий фильтр. Доступен исходный порядок, сортировка по типу или сначала непроверенные; равные приоритеты сохраняют порядок источника. | F: `filters by type and expert review status, including unreviewed by default`, `sorts by type or expert review with stable ties and preserves server input` |
| 30 | При заданном `API_TOKEN` защищены также `/docs`, `/redoc` и `/openapi.json`; локальный режим без токена сохраняет доступ к документации. | R: `test_documentation_requires_configured_bearer_token`, `test_documentation_available_locally_without_token` |
| 31 | Чистое переименование владельца сохраняет функцию; интерфейс не переименовывает этот статус в «Передана». | A: `test_qa03_31_renamed_unit_keeps_its_functions`; F: `shows preserved functions after a pure department rename as the backend reports` |

## Границы демонстрационного анализа

- `demo` использует правила для формулировок, заголовков, окончаний глагола и явно заданных
  прежних названий. Это не семантический анализ: перефразирования, неявные преобразования
  подразделений и сложные условия могут потребовать режима `llm` и проверки человеком.
- Конфликт обязанность/запрет или право/запрет проверяется для одного владельца с одинаковым
  действием и областью. Перенос запрета между должностью и подразделением через доказанную
  связь полномочий пока не реализован; такой межуровневый конфликт нельзя считать покрытым.
- Сходство строк в текстовом сравнении помогает читать правки; оно не доказывает сохранение
  либо утрату функции. Исходные документы и цитаты остаются основанием проверки.
- Неполное извлечение, неизвестный владелец и нераспознанная структура показываются явно.
  Отсутствие соответствия при неполном покрытии не объявляется доказанной потерей.
- Тесты демонстрационного режима не подтверждают качество живой языковой модели.
  OCR для сканов и изображений не добавлен; ограничения извлечения должны учитываться.

## Итоговая проверка

- Бэкенд: **217 тестов прошли**, Ruff без ошибок.
- Фронтенд: **71 модульный тест прошёл**, TypeScript и production-сборка прошли.
- Chromium, Firefox, мобильный Chromium: **33 браузерных теста прошли**.
- Восстановление после ошибок API: **5 браузерных тестов прошли**.
- OpenAPI экспортирован заново; API.md обновлён.
- Обновлённый сайт и бэкенд запущены на `http://127.0.0.1:8000`.

Подробности окружения, проверок и ограничений — [VALIDATION.md](VALIDATION.md).

## Совместимость после объединения с GitHub

Исправления №1–31 объединены в рабочей копии с `origin/main` (`7b24222`), без нового
коммита и push. Возможности GitHub сохраняются вместе с исправлениями QA; для API
добавлен [test_github_merge.py](../backend/tests/test_github_merge.py):

| Проверка совместимости | Регрессия |
| --- | --- |
| TXT, включая имя `.txt`, исходные байты, BOM/CRLF и физические номера строк | `test_github_txt_upload_preserves_original_and_physical_source_lines` |
| Бинарные и повреждённые TXT отклоняются без оставшихся файлов и записей | `test_github_binary_or_damaged_txt_is_rejected_without_mutating_storage` |
| Новые TXT работают с QA-анализом подчинения, оценками, отчётами и полным удалением | `test_github_txt_keeps_qa_reporting_review_export_and_cascade_delete` |
| В OpenAPI одновременно сохранены формат `txt`, `reporting_change`, DELETE и `ReportExport` | `test_github_openapi_has_txt_enum_and_local_qa_contract` |

Точечный API-прогон: **10 тестов прошли** (включены в общий прогон бэкенда).
Дополнительные проверки парсера покрывают TXT и геометрию PDF вместе с прежними
QA-правилами. [github-merge.test.ts](../frontend/tests/unit/github-merge.test.ts)
добавляет 17 проверок совместимости исходного XLSX-текста, повторов, фильтров и TXT.
Браузерный прогон также проверяет TXT и переходы к источникам повторов во всех трёх
браузерных конфигурациях. Итоговые числа выше относятся к объединённой версии.

## Второй QA: Н1–Н9

Регрессии: [test_qa_round2.py](../backend/tests/test_qa_round2.py) (19 сценариев),
[qa-round2.test.ts](../frontend/tests/unit/qa-round2.test.ts) (8 сценариев).

| Пункт | Исправление |
| --- | --- |
| Н1 | Явные владельцы отключают эвристику заголовка; частые названия приводятся к именительному падежу, суффикс редакции удаляется. |
| Н2 | Функции извлекаются из нормативных разделов. Общие положения, задачи, ответственность, взаимодействие и заключительные положения исключены; неизвестный раздел даёт предупреждение и неполное покрытие. |
| Н3 | Общие ссылки «Отдел/Управление/Служба имеет право» сохраняют владельца и переключают вид на право. |
| Н4–Н5 | Markdown-метасимволы экранируются, кавычки остаются читаемыми, комментарии сохраняют строки. |
| Н6 | Явное переименование приоритетнее совпадения нового владельца с прежним именем. Точное имя по-прежнему определяет владельца функции внутри одной версии. |
| Н7 | У одного владельца близкие длинные действия (сходство токенов ≥ 0.85) сопоставляются как изменённые; объяснение перечисляет заменённые слова. Неоднозначные кандидаты не объединяются произвольно. |
| Н8 | Лимит 1000 функций на каждую сторону; сообщение содержит оба количества и лимит. Проверена пара по 449 функций. |
| Н9 | Автоназвание из файлов, свёрнутый список истории после 4 файлов, единый термин подчинения, отдельная карточка повторов, предупреждение сбоку документа, отказ неоднозначным старым кодировкам, выравнивание ё/е с сохранением исходного текста. |

Правила нормализации названий и определения старых кодировок остаются эвристическими;
неоднозначный TXT следует пересохранить в UTF-8. Семантический ИИ в этом прогоне не использовался.
