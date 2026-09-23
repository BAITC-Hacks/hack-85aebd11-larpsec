export type DiffSegment = { text: string; changed: boolean };

export type DiffLine = {
  number: number;
  text: string;
  segments: DiffSegment[];
};

export type DiffRow = {
  id: string;
  kind: 'equal' | 'removed' | 'added' | 'modified';
  before: DiffLine | null;
  after: DiffLine | null;
};

export type TextDiff = {
  rows: DiffRow[];
  removedLines: number;
  addedLines: number;
  changeBlocks: number;
};

type SourceLine = { number: number; text: string; key: string };
type Edit =
  | { kind: 'equal'; before: SourceLine; after: SourceLine }
  | { kind: 'removed'; before: SourceLine }
  | { kind: 'added'; after: SourceLine };
type Budget = { alignment: number; inline: number };
type Anchor = { before: number; after: number };
type Token = { text: string; key: string };

// Bound the work independently of document similarity. A large replacement may
// use a coarser alignment, but every nonblank source line is still returned.
const MAX_MATRIX_CELLS = 65_536;
const MAX_INLINE_CELLS = 16_384;
const MAX_EDIT_DISTANCE = 256;
const MAX_ANCHOR_DEPTH = 24;
const ALIGNMENT_BUDGET = 2_000_000;
const INLINE_BUDGET = 300_000;

function comparisonKey(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  for (const original of text.split(/\r\n|\n|\r/u)) {
    const key = comparisonKey(original);
    if (key) lines.push({ number: lines.length + 1, text: original, key });
  }
  return lines;
}

function lcsTable(before: readonly string[], after: readonly string[]): Uint32Array {
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      const index = left * width + right;
      table[index] = before[left] === after[right]
        ? table[index + width + 1] + 1
        : Math.max(table[index + width], table[index + 1]);
    }
  }
  return table;
}

function appendSmallDiff(
  before: SourceLine[], after: SourceLine[],
  beforeStart: number, beforeEnd: number, afterStart: number, afterEnd: number,
  edits: Edit[],
): void {
  const left = before.slice(beforeStart, beforeEnd);
  const right = after.slice(afterStart, afterEnd);
  const width = right.length + 1;
  const table = lcsTable(left.map((line) => line.key), right.map((line) => line.key));
  let a = 0;
  let b = 0;
  while (a < left.length || b < right.length) {
    if (a < left.length && b < right.length && left[a].key === right[b].key) {
      edits.push({ kind: 'equal', before: left[a++], after: right[b++] });
    } else if (a < left.length && (b === right.length || table[(a + 1) * width + b] >= table[a * width + b + 1])) {
      edits.push({ kind: 'removed', before: left[a++] });
    } else {
      edits.push({ kind: 'added', after: right[b++] });
    }
  }
}

// Patience anchors keep inserted paragraphs from shifting all following rows.
// Only lines unique in both current ranges are candidates; an increasing
// subsequence ensures that anchors never reorder either original document.
function uniqueAnchors(
  before: SourceLine[], after: SourceLine[],
  beforeStart: number, beforeEnd: number, afterStart: number, afterEnd: number,
): Anchor[] {
  const left = new Map<string, number>();
  const right = new Map<string, number>();
  for (let index = beforeStart; index < beforeEnd; index += 1) {
    const key = before[index].key;
    left.set(key, left.has(key) ? -1 : index);
  }
  for (let index = afterStart; index < afterEnd; index += 1) {
    const key = after[index].key;
    right.set(key, right.has(key) ? -1 : index);
  }

  const candidates: Anchor[] = [];
  for (const [key, beforeIndex] of left) {
    const afterIndex = right.get(key);
    if (beforeIndex >= 0 && afterIndex !== undefined && afterIndex >= 0) {
      candidates.push({ before: beforeIndex, after: afterIndex });
    }
  }
  const tails: number[] = [];
  const previous = new Int32Array(candidates.length).fill(-1);
  for (let index = 0; index < candidates.length; index += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[tails[middle]].after < candidates[index].after) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  }
  const anchors: Anchor[] = [];
  let cursor = tails.length ? tails[tails.length - 1] : -1;
  while (cursor >= 0) {
    anchors.push(candidates[cursor]);
    cursor = previous[cursor];
  }
  return anchors.reverse();
}

// Repeated lines cannot become patience anchors. A bounded Myers search still
// aligns those blocks when they differ by a small number of insertions/removals.
function boundedDiff(
  before: SourceLine[], after: SourceLine[],
  beforeStart: number, beforeEnd: number, afterStart: number, afterEnd: number,
  budget: Budget,
): Edit[] | null {
  const leftLength = beforeEnd - beforeStart;
  const rightLength = afterEnd - afterStart;
  const maximum = Math.min(MAX_EDIT_DISTANCE, leftLength + rightLength);
  if (Math.abs(leftLength - rightLength) > maximum || budget.alignment <= 0) return null;
  const offset = maximum + 1;
  const frontier = new Int32Array(maximum * 2 + 3).fill(-1);
  frontier[offset + 1] = 0;
  const trace: Int32Array[] = [];

  for (let distance = 0; distance <= maximum; distance += 1) {
    trace.push(frontier.slice());
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (--budget.alignment < 0) return null;
      const index = offset + diagonal;
      let x = diagonal === -distance || (diagonal !== distance && frontier[index - 1] < frontier[index + 1])
        ? frontier[index + 1]
        : frontier[index - 1] + 1;
      let y = x - diagonal;
      while (x < leftLength && y < rightLength && before[beforeStart + x].key === after[afterStart + y].key) {
        if (--budget.alignment < 0) return null;
        x += 1;
        y += 1;
      }
      frontier[index] = x;
      if (x >= leftLength && y >= rightLength) {
        const edits: Edit[] = [];
        x = leftLength;
        y = rightLength;
        for (let step = distance; step >= 0; step -= 1) {
          const previousFrontier = trace[step];
          const k = x - y;
          const previousK = k === -step || (k !== step && previousFrontier[offset + k - 1] < previousFrontier[offset + k + 1])
            ? k + 1
            : k - 1;
          const previousX = previousFrontier[offset + previousK];
          const previousY = previousX - previousK;
          while (x > previousX && y > previousY) {
            edits.push({ kind: 'equal', before: before[beforeStart + --x], after: after[afterStart + --y] });
          }
          if (step === 0) break;
          if (x === previousX) edits.push({ kind: 'added', after: after[afterStart + --y] });
          else edits.push({ kind: 'removed', before: before[beforeStart + --x] });
        }
        return edits.reverse();
      }
    }
  }
  return null;
}

function alignLines(
  before: SourceLine[], after: SourceLine[],
  beforeStart: number, beforeEnd: number, afterStart: number, afterEnd: number,
  edits: Edit[], budget: Budget, depth = 0,
): void {
  while (beforeStart < beforeEnd && afterStart < afterEnd && before[beforeStart].key === after[afterStart].key) {
    edits.push({ kind: 'equal', before: before[beforeStart++], after: after[afterStart++] });
  }
  let suffix = 0;
  while (beforeStart < beforeEnd && afterStart < afterEnd && before[beforeEnd - 1].key === after[afterEnd - 1].key) {
    beforeEnd -= 1;
    afterEnd -= 1;
    suffix += 1;
  }

  const matrixCells = (beforeEnd - beforeStart + 1) * (afterEnd - afterStart + 1);
  if (beforeStart === beforeEnd || afterStart === afterEnd) {
    for (let a = beforeStart; a < beforeEnd; a += 1) edits.push({ kind: 'removed', before: before[a] });
    for (let b = afterStart; b < afterEnd; b += 1) edits.push({ kind: 'added', after: after[b] });
  } else if (matrixCells <= MAX_MATRIX_CELLS && budget.alignment >= matrixCells) {
    budget.alignment -= matrixCells;
    appendSmallDiff(before, after, beforeStart, beforeEnd, afterStart, afterEnd, edits);
  } else {
    const scanCost = beforeEnd - beforeStart + afterEnd - afterStart;
    const canAnchor = depth < MAX_ANCHOR_DEPTH && budget.alignment >= scanCost;
    if (canAnchor) budget.alignment -= scanCost;
    const anchors = canAnchor ? uniqueAnchors(before, after, beforeStart, beforeEnd, afterStart, afterEnd) : [];
    if (anchors.length) {
      let a = beforeStart;
      let b = afterStart;
      for (const anchor of anchors) {
        alignLines(before, after, a, anchor.before, b, anchor.after, edits, budget, depth + 1);
        edits.push({ kind: 'equal', before: before[anchor.before], after: after[anchor.after] });
        a = anchor.before + 1;
        b = anchor.after + 1;
      }
      alignLines(before, after, a, beforeEnd, b, afterEnd, edits, budget, depth + 1);
    } else {
      const bounded = boundedDiff(before, after, beforeStart, beforeEnd, afterStart, afterEnd, budget);
      if (bounded) {
        // Avoid spreading an arbitrarily large document into function arguments.
        for (const edit of bounded) edits.push(edit);
      } else {
        for (let a = beforeStart; a < beforeEnd; a += 1) edits.push({ kind: 'removed', before: before[a] });
        for (let b = afterStart; b < afterEnd; b += 1) edits.push({ kind: 'added', after: after[b] });
      }
    }
  }
  for (let index = 0; index < suffix; index += 1) {
    edits.push({ kind: 'equal', before: before[beforeEnd + index], after: after[afterEnd + index] });
  }
}

function appendSegment(segments: DiffSegment[], text: string, changed: boolean): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last?.changed === changed) last.text += text;
  else segments.push({ text, changed });
}

function tokenize(text: string): Token[] {
  return (text.match(/\s+|[\p{L}\p{M}\p{N}_]+|[^\s\p{L}\p{M}\p{N}_]/gu) ?? [])
    .map((token) => ({ text: token, key: /^\s+$/u.test(token) ? ' ' : token }));
}

function inlineSegments(before: string, after: string, budget: Budget): [DiffSegment[], DiffSegment[]] {
  const left = tokenize(before);
  const right = tokenize(after);
  const beforeSegments: DiffSegment[] = [];
  const afterSegments: DiffSegment[] = [];
  let start = 0;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (start < leftEnd && start < rightEnd && left[start].key === right[start].key) {
    appendSegment(beforeSegments, left[start].text, false);
    appendSegment(afterSegments, right[start].text, false);
    start += 1;
  }
  while (start < leftEnd && start < rightEnd && left[leftEnd - 1].key === right[rightEnd - 1].key) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  const cells = (leftEnd - start + 1) * (rightEnd - start + 1);
  if (leftEnd > start && rightEnd > start && cells <= MAX_INLINE_CELLS && budget.inline >= cells) {
    budget.inline -= cells;
    const beforeKeys = left.slice(start, leftEnd).map((token) => token.key);
    const afterKeys = right.slice(start, rightEnd).map((token) => token.key);
    const width = afterKeys.length + 1;
    const table = lcsTable(beforeKeys, afterKeys);
    let a = 0;
    let b = 0;
    while (a < beforeKeys.length || b < afterKeys.length) {
      if (a < beforeKeys.length && b < afterKeys.length && beforeKeys[a] === afterKeys[b]) {
        appendSegment(beforeSegments, left[start + a++].text, false);
        appendSegment(afterSegments, right[start + b++].text, false);
      } else if (a < beforeKeys.length && (b === afterKeys.length || table[(a + 1) * width + b] >= table[a * width + b + 1])) {
        appendSegment(beforeSegments, left[start + a++].text, true);
      } else {
        appendSegment(afterSegments, right[start + b++].text, true);
      }
    }
  } else {
    for (let a = start; a < leftEnd; a += 1) appendSegment(beforeSegments, left[a].text, true);
    for (let b = start; b < rightEnd; b += 1) appendSegment(afterSegments, right[b].text, true);
  }
  for (let a = leftEnd; a < left.length; a += 1) appendSegment(beforeSegments, left[a].text, false);
  for (let b = rightEnd; b < right.length; b += 1) appendSegment(afterSegments, right[b].text, false);
  return [beforeSegments, afterSegments];
}

function displayLine(line: SourceLine, changed: boolean): DiffLine {
  return { number: line.number, text: line.text, segments: [{ text: line.text, changed }] };
}

/**
 * Compare nonblank lines, ignoring whitespace differences for alignment only.
 * Text and word segments retain the original characters on each side. Line
 * numbers count displayed nonblank lines independently in the two documents.
 */
export function buildTextDiff(beforeText: string, afterText: string): TextDiff {
  const before = sourceLines(beforeText);
  const after = sourceLines(afterText);
  const edits: Edit[] = [];
  const budget: Budget = { alignment: ALIGNMENT_BUDGET, inline: INLINE_BUDGET };
  alignLines(before, after, 0, before.length, 0, after.length, edits, budget);

  const rows: DiffRow[] = [];
  let removedLines = 0;
  let addedLines = 0;
  let changeBlocks = 0;
  let inChangeBlock = false;
  const appendRow = (left: SourceLine | null, right: SourceLine | null) => {
    const kind: DiffRow['kind'] = left && right
      ? left.key === right.key ? 'equal' : 'modified'
      : left ? 'removed' : 'added';
    let beforeLine = left ? displayLine(left, kind !== 'equal') : null;
    let afterLine = right ? displayLine(right, kind !== 'equal') : null;
    if (kind === 'modified' && left && right) {
      const [beforeSegments, afterSegments] = inlineSegments(left.text, right.text, budget);
      beforeLine = { number: left.number, text: left.text, segments: beforeSegments };
      afterLine = { number: right.number, text: right.text, segments: afterSegments };
    }
    if (kind !== 'equal') {
      if (left) removedLines += 1;
      if (right) addedLines += 1;
      if (!inChangeBlock) changeBlocks += 1;
    }
    inChangeBlock = kind !== 'equal';
    rows.push({ id: `line-${left?.number ?? 0}-${right?.number ?? 0}`, kind, before: beforeLine, after: afterLine });
  };

  let index = 0;
  while (index < edits.length) {
    const edit = edits[index];
    if (edit.kind === 'equal') {
      appendRow(edit.before, edit.after);
      index += 1;
      continue;
    }
    const removed: SourceLine[] = [];
    const added: SourceLine[] = [];
    while (index < edits.length && edits[index].kind !== 'equal') {
      const change = edits[index++];
      if (change.kind === 'removed') removed.push(change.before);
      if (change.kind === 'added') added.push(change.after);
    }
    const count = Math.max(removed.length, added.length);
    for (let row = 0; row < count; row += 1) appendRow(removed[row] ?? null, added[row] ?? null);
  }
  return { rows, removedLines, addedLines, changeBlocks };
}
