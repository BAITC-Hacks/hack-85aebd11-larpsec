export type TextRange = { start: number; end: number };

function columnNumber(column: string): number {
  let value = 0;
  for (const letter of column) value = value * 26 + letter.charCodeAt(0) - 64;
  return value;
}

/**
 * Locate row numbers only in the parser's cell prefixes, within one XLSX
 * fragment. No multiline anchors: a new line inside a cell is still its value.
 * Other cell prefixes must use the same row and increasing column letters.
 */
export function xlsxRowNumberRanges(text: string, locator?: string): TextRange[] {
  const first = text.match(/^([A-Z]{1,3})([1-9]\d*): /u);
  if (!first || columnNumber(first[1]) > 16_384) return [];
  const row = first[2];
  if (Number(row) > 1_048_576) return [];
  let lastColumn = columnNumber(first[1]);
  const ranges = [{ start: first[1].length, end: first[1].length + row.length }];
  const bounds = locator?.match(/, ([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)(?:, часть (\d+))?$/u);
  // Without the parser's cell range, only the initial prefix is reliable.
  // Split fragments can begin/end inside a value, so keep those conservative.
  if (bounds?.[5]) return [];
  if (!bounds) return ranges;
  const lastAllowedColumn = columnNumber(bounds[3]);
  if (bounds[2] !== row || bounds[4] !== row || columnNumber(bounds[1]) !== lastColumn || lastAllowedColumn < lastColumn || lastAllowedColumn > 16_384) return [];
  for (const prefix of text.matchAll(/ \| ([A-Z]{1,3})([1-9]\d*): /gu)) {
    const column = columnNumber(prefix[1]);
    if (prefix[2] !== row || column < columnNumber(bounds[1]) || column > lastAllowedColumn) continue;
    // An address-like value plus a real cell prefix can duplicate a column.
    // Refuse the optimization when their ordering is ambiguous.
    if (column <= lastColumn) return [];
    lastColumn = column;
    const start = prefix.index + 3 + prefix[1].length;
    ranges.push({ start, end: start + row.length });
  }
  return lastColumn === lastAllowedColumn ? ranges : [];
}

/** Build a comparison key without modifying the original source text. */
export function omitTextRanges(text: string, ranges: readonly TextRange[]): string {
  let cursor = 0;
  const pieces: string[] = [];
  for (const range of ranges) {
    pieces.push(text.slice(cursor, range.start));
    cursor = range.end;
  }
  pieces.push(text.slice(cursor));
  return pieces.join('');
}

export function xlsxComparisonText(text: string, locator?: string): string {
  return omitTextRanges(text, xlsxCellPrefixRanges(text, locator));
}

/** Ignore verified parser addresses, while preserving all original display text. */
export function xlsxCellPrefixRanges(text: string, locator?: string): TextRange[] {
  return xlsxRowNumberRanges(text, locator).map((range) => {
    let start = range.start;
    while (start > 0 && /[A-Z]/u.test(text[start - 1])) start -= 1;
    return { start, end: range.end + 2 }; // Include the parser's ": " separator.
  });
}
