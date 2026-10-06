import type {
  ChangeContent,
  ContextContent,
  FileContents,
  FileDiffMetadata,
  FileIntraLineRanges,
  Hunk,
} from '../types';
import { parseDiffFromFile } from './parseDiffFromFile';

/**
 * One rendered row of a side-by-side view: zero-based line indexes into the
 * old and new file. `null` means that side has no line on this row.
 */
export type StructuralRow = readonly [
  deletionLineIndex: number | null,
  additionLineIndex: number | null,
];

export interface StructuralDiffInput {
  /**
   * Every line of both files, in display order. Unchanged lines are paired.
   * This is the host's alignment (e.g. difftastic `aligned_lines`); it is
   * rendered as given.
   */
  rows: ReadonlyArray<StructuralRow>;
  /** Zero-based old-file line indexes that the host marks as changed. */
  changedDeletionLines: Iterable<number>;
  /** Zero-based new-file line indexes that the host marks as changed. */
  changedAdditionLines: Iterable<number>;
  /** Changed tokens per line. Lines without an entry render no token marks. */
  intraLineRanges?: FileIntraLineRanges;
  /** Unchanged rows kept around each change. Defaults to 3. */
  contextLines?: number;
}

/**
 * Builds diff metadata whose alignment, hunks and changed tokens all come
 * from the host instead of from a line diff. The built-in line and word diff
 * never runs for the returned file: rows pair exactly as `rows` says, and
 * only `intraLineRanges` are emphasized. A row with one side whose line is
 * not in `changedDeletionLines` / `changedAdditionLines` is neutral: it
 * renders as context on its side (see `FileDiffMetadata.neutralLines`).
 */
export function createStructuralDiff(
  oldFile: FileContents,
  newFile: FileContents,
  input: StructuralDiffInput
): FileDiffMetadata {
  const base = parseDiffFromFile(oldFile, newFile);
  const changedDeletions = new Set(input.changedDeletionLines);
  const changedAdditions = new Set(input.changedAdditionLines);
  const context = Math.max(0, input.contextLines ?? 3);
  const { rows } = input;

  validateRows(rows, base.deletionLines.length, base.additionLines.length);

  const isChanged = (row: StructuralRow) =>
    row[0] == null ||
    row[1] == null ||
    changedDeletions.has(row[0]) ||
    changedAdditions.has(row[1]);

  // Row ranges [start, end) for each hunk: changed rows widened by context,
  // merged when they touch.
  const ranges: [number, number][] = [];
  for (let index = 0; index < rows.length; index++) {
    if (!isChanged(rows[index])) {
      continue;
    }
    const start = Math.max(0, index - context);
    const end = Math.min(rows.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last != null && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  // One-sided rows that the host did not list as changed. They still sit in a
  // change block, because only a change block can hold a row with one side,
  // and render as context.
  const neutralDeletions: number[] = [];
  const neutralAdditions: number[] = [];
  for (const [deletion, addition] of rows) {
    if (
      deletion != null &&
      addition == null &&
      !changedDeletions.has(deletion)
    ) {
      neutralDeletions.push(deletion);
    } else if (
      addition != null &&
      deletion == null &&
      !changedAdditions.has(addition)
    ) {
      neutralAdditions.push(addition);
    }
  }

  const hunks: Hunk[] = [];
  let splitLineCount = 0;
  let unifiedLineCount = 0;
  let previousEnd = 0;
  // Lines consumed on each side before the current row.
  let deletionCursor = 0;
  let additionCursor = 0;
  let rowCursor = 0;

  for (const [start, end] of ranges) {
    for (; rowCursor < start; rowCursor++) {
      deletionCursor += rows[rowCursor][0] == null ? 0 : 1;
      additionCursor += rows[rowCursor][1] == null ? 0 : 1;
    }
    const hunkContent: (ContextContent | ChangeContent)[] = [];
    const deletionLineIndex = deletionCursor;
    const additionLineIndex = additionCursor;
    let deletionLines = 0;
    let additionLines = 0;
    let hunkSplit = 0;
    let hunkUnified = 0;

    for (; rowCursor < end; rowCursor++) {
      const row = rows[rowCursor];
      const [deletion, addition] = row;
      const last = hunkContent[hunkContent.length - 1];
      if (!isChanged(row)) {
        if (last?.type === 'context') {
          last.lines++;
        } else {
          hunkContent.push({
            type: 'context',
            lines: 1,
            deletionLineIndex: deletionCursor,
            additionLineIndex: additionCursor,
          });
        }
        hunkSplit++;
        hunkUnified++;
      } else {
        // A change block renders deletion i beside addition i, so a block may
        // only grow while that pairing still matches the host's rows: paired
        // rows extend a block of paired rows, one-sided rows extend a block of
        // the same side.
        const shape =
          deletion != null && addition != null
            ? 'pair'
            : deletion != null
              ? 'deletion'
              : 'addition';
        const lastShape =
          last?.type !== 'change'
            ? null
            : last.deletions === last.additions
              ? 'pair'
              : last.additions === 0
                ? 'deletion'
                : last.deletions === 0
                  ? 'addition'
                  : null;
        if (last?.type === 'change' && lastShape === shape) {
          last.deletions += deletion == null ? 0 : 1;
          last.additions += addition == null ? 0 : 1;
        } else {
          hunkContent.push({
            type: 'change',
            deletions: deletion == null ? 0 : 1,
            deletionLineIndex: deletionCursor,
            additions: addition == null ? 0 : 1,
            additionLineIndex: additionCursor,
          });
        }
        deletionLines += deletion == null ? 0 : 1;
        additionLines += addition == null ? 0 : 1;
        hunkSplit++;
        hunkUnified += (deletion == null ? 0 : 1) + (addition == null ? 0 : 1);
      }
      deletionCursor += deletion == null ? 0 : 1;
      additionCursor += addition == null ? 0 : 1;
    }

    const deletionCount = deletionCursor - deletionLineIndex;
    const additionCount = additionCursor - additionLineIndex;
    const collapsedBefore = start - previousEnd;
    hunks.push({
      collapsedBefore,
      additionStart:
        additionCount === 0 ? additionLineIndex : additionLineIndex + 1,
      additionCount,
      additionLines,
      additionLineIndex,
      deletionStart:
        deletionCount === 0 ? deletionLineIndex : deletionLineIndex + 1,
      deletionCount,
      deletionLines,
      deletionLineIndex,
      hunkContent,
      hunkSpecs: `@@ -${deletionCount === 0 ? deletionLineIndex : deletionLineIndex + 1},${deletionCount} +${additionCount === 0 ? additionLineIndex : additionLineIndex + 1},${additionCount} @@`,
      splitLineStart: splitLineCount + collapsedBefore,
      splitLineCount: hunkSplit,
      unifiedLineStart: unifiedLineCount + collapsedBefore,
      unifiedLineCount: hunkUnified,
      noEOFCRAdditions: false,
      noEOFCRDeletions: false,
    });
    splitLineCount += collapsedBefore + hunkSplit;
    unifiedLineCount += collapsedBefore + hunkUnified;
    previousEnd = end;
  }

  const collapsedAfter = hunks.length > 0 ? rows.length - previousEnd : 0;
  const lastBase = base.hunks[base.hunks.length - 1];
  const lastHunk = hunks[hunks.length - 1];
  if (lastHunk != null && lastBase != null && collapsedAfter === 0) {
    lastHunk.noEOFCRAdditions = lastBase.noEOFCRAdditions;
    lastHunk.noEOFCRDeletions = lastBase.noEOFCRDeletions;
  }

  return {
    ...base,
    hunks,
    splitLineCount: splitLineCount + collapsedAfter,
    unifiedLineCount: unifiedLineCount + collapsedAfter,
    // Always set, so the renderer never falls back to its own word diff for
    // this file, even when the host found no token-level changes.
    intraLineRanges: input.intraLineRanges ?? {},
    ...(neutralDeletions.length > 0 || neutralAdditions.length > 0
      ? {
          neutralLines: {
            ...(neutralDeletions.length > 0
              ? { deletions: neutralDeletions }
              : {}),
            ...(neutralAdditions.length > 0
              ? { additions: neutralAdditions }
              : {}),
          },
        }
      : {}),
  };
}

function validateRows(
  rows: ReadonlyArray<StructuralRow>,
  deletionLineCount: number,
  additionLineCount: number
) {
  let nextDeletion = 0;
  let nextAddition = 0;
  for (const [deletion, addition] of rows) {
    if (deletion == null && addition == null) {
      throw new Error('createStructuralDiff: a row has no line on either side');
    }
    if (deletion != null && deletion !== nextDeletion++) {
      throw new Error(
        `createStructuralDiff: old-file lines must appear once, in order (row has ${deletion}, expected ${nextDeletion - 1})`
      );
    }
    if (addition != null && addition !== nextAddition++) {
      throw new Error(
        `createStructuralDiff: new-file lines must appear once, in order (row has ${addition}, expected ${nextAddition - 1})`
      );
    }
  }
  if (
    nextDeletion !== deletionLineCount ||
    nextAddition !== additionLineCount
  ) {
    throw new Error(
      `createStructuralDiff: rows cover ${nextDeletion} old and ${nextAddition} new lines; the files have ${deletionLineCount} and ${additionLineCount}`
    );
  }
}
