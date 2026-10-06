import { describe, expect, test } from 'bun:test';

import { createStructuralDiff, DiffHunksRenderer } from '../src';
import type { StructuralRow } from '../src';
import { collectAllElements } from './testUtils';

const file = (name: string, lines: string[]) => ({
  name,
  contents: lines.map((line) => `${line}\n`).join(''),
});

// Old: a function was reformatted (lines 1-2 joined) and one token changed.
const oldLines = [
  'import { a } from "a";',
  'export function total(',
  '  items) {',
  '  return items.length;',
  '}',
  'const unused = 1;',
  'export const z = 1;',
];
const newLines = [
  'import { a } from "a";',
  'export function total(items) {',
  '  return items.size;',
  '}',
  'export const z = 1;',
  'export const added = 2;',
];
// Host alignment: old 1+2 sit beside new 1; old 5 has no partner; new 5 is new.
const rows: StructuralRow[] = [
  [0, 0],
  [1, 1],
  [2, null],
  [3, 2],
  [4, 3],
  [5, null],
  [6, 4],
  [null, 5],
];

describe('createStructuralDiff', () => {
  test('hunks follow the host rows, not a line diff', () => {
    const diff = createStructuralDiff(
      file('a.ts', oldLines),
      file('a.ts', newLines),
      {
        rows,
        // The reformat (old 1-2 → new 1) is not a change for the host.
        changedDeletionLines: [3, 5],
        changedAdditionLines: [2, 5],
        contextLines: 1,
      }
    );

    expect(diff.hunks).toHaveLength(1);
    const [hunk] = diff.hunks;
    expect(hunk.collapsedBefore).toBe(1);
    expect(hunk.hunkContent).toEqual([
      // Row [1, 1] is context for the host even though the text differs.
      { type: 'context', lines: 1, deletionLineIndex: 1, additionLineIndex: 1 },
      {
        type: 'change',
        deletions: 1,
        deletionLineIndex: 2,
        additions: 0,
        additionLineIndex: 2,
      },
      {
        type: 'change',
        deletions: 1,
        deletionLineIndex: 3,
        additions: 1,
        additionLineIndex: 2,
      },
      { type: 'context', lines: 1, deletionLineIndex: 4, additionLineIndex: 3 },
      {
        type: 'change',
        deletions: 1,
        deletionLineIndex: 5,
        additions: 0,
        additionLineIndex: 4,
      },
      { type: 'context', lines: 1, deletionLineIndex: 6, additionLineIndex: 4 },
      {
        type: 'change',
        deletions: 0,
        deletionLineIndex: 7,
        additions: 1,
        additionLineIndex: 5,
      },
    ]);
    expect([
      hunk.deletionStart,
      hunk.deletionCount,
      hunk.deletionLines,
    ]).toEqual([2, 6, 3]);
    expect([
      hunk.additionStart,
      hunk.additionCount,
      hunk.additionLines,
    ]).toEqual([2, 5, 2]);
    expect([hunk.splitLineStart, hunk.splitLineCount]).toEqual([1, 7]);
    expect([hunk.unifiedLineStart, hunk.unifiedLineCount]).toEqual([1, 8]);
    expect(diff.splitLineCount).toBe(rows.length);
    expect(diff.deletionLines).toHaveLength(oldLines.length);
    expect(diff.additionLines).toHaveLength(newLines.length);
  });

  test('distant changes become separate hunks with collapsed rows between', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const next = lines.map((line, index) =>
      index === 2 || index === 30 ? `${line} changed` : line
    );
    const diff = createStructuralDiff(file('b.ts', lines), file('b.ts', next), {
      rows: lines.map((_, index) => [index, index] as const),
      changedDeletionLines: [2, 30],
      changedAdditionLines: [2, 30],
    });
    expect(
      diff.hunks.map((hunk) => [
        hunk.collapsedBefore,
        hunk.additionStart,
        hunk.additionCount,
      ])
    ).toEqual([
      [0, 1, 6],
      [21, 28, 7],
    ]);
    expect(diff.hunks[1].splitLineStart).toBe(27);
    expect(diff.splitLineCount).toBe(40);
    expect(diff.unifiedLineCount).toBe(42);
  });

  test('consecutive paired rows share a block; one-sided runs share a block', () => {
    const diff = createStructuralDiff(
      file('c.ts', ['a', 'b', 'x', 'y']),
      file('c.ts', ['A', 'B', 'n1', 'n2']),
      {
        rows: [
          [0, 0],
          [1, 1],
          [2, null],
          [3, null],
          [null, 2],
          [null, 3],
        ],
        changedDeletionLines: [0, 1, 2, 3],
        changedAdditionLines: [0, 1, 2, 3],
      }
    );
    expect(diff.hunks[0].hunkContent).toEqual([
      {
        type: 'change',
        deletions: 2,
        deletionLineIndex: 0,
        additions: 2,
        additionLineIndex: 0,
      },
      {
        type: 'change',
        deletions: 2,
        deletionLineIndex: 2,
        additions: 0,
        additionLineIndex: 2,
      },
      {
        type: 'change',
        deletions: 0,
        deletionLineIndex: 4,
        additions: 2,
        additionLineIndex: 2,
      },
    ]);
    expect(diff.hunks[0].splitLineCount).toBe(6);
  });

  test('no changed rows yields no hunks, and the built-in word diff stays off', () => {
    const lines = ['same', 'same too'];
    const diff = createStructuralDiff(
      file('d.ts', lines),
      file('d.ts', lines),
      {
        rows: [
          [0, 0],
          [1, 1],
        ],
        changedDeletionLines: [],
        changedAdditionLines: [],
      }
    );
    expect(diff.hunks).toEqual([]);
    expect(diff.intraLineRanges).toEqual({});
  });

  test('rows that skip, repeat or miss lines are rejected', () => {
    const args = [file('e.ts', ['a', 'b']), file('e.ts', ['a', 'b'])] as const;
    const changed = { changedDeletionLines: [], changedAdditionLines: [] };
    expect(() =>
      createStructuralDiff(...args, { rows: [[0, 0]], ...changed })
    ).toThrow(/rows cover 1 old and 1 new lines/);
    expect(() =>
      createStructuralDiff(...args, {
        rows: [
          [1, 0],
          [0, 1],
        ],
        ...changed,
      })
    ).toThrow(/in order/);
    expect(() =>
      createStructuralDiff(...args, {
        rows: [
          [0, 0],
          [null, null],
          [1, 1],
        ],
        ...changed,
      })
    ).toThrow(/no line on either side/);
  });

  test('renders only host token ranges, on the rows the host paired', async () => {
    const diff = createStructuralDiff(
      file('a.ts', oldLines),
      file('a.ts', newLines),
      {
        rows,
        changedDeletionLines: [3, 5],
        changedAdditionLines: [2, 5],
        intraLineRanges: {
          deletions: { 3: [{ start: 15, end: 21 }] },
          additions: { 2: [{ start: 15, end: 19 }] },
        },
        contextLines: 1,
      }
    );
    const renderer = new DiffHunksRenderer({
      diffStyle: 'split',
      lineDiffType: 'word',
    });
    const result = await renderer.asyncRender(diff);
    const spans = [
      ...collectAllElements(result.additionsContentAST ?? []),
      ...collectAllElements(result.deletionsContentAST ?? []),
    ].filter((element) => element.properties?.['data-diff-span'] != null);
    // One span per side. The reformatted signature (old 1-2 beside new 1) and
    // the one-sided rows carry none, although a word diff would mark them.
    expect(spans).toHaveLength(2);
  });

  test('a one-sided row that the host did not mark as changed is neutral', () => {
    const diff = createStructuralDiff(
      file('a.ts', oldLines),
      file('a.ts', newLines),
      {
        rows,
        // Old line 2 sits opposite nothing (the reformat) and is not listed.
        // Old line 5 and new line 5 sit opposite nothing and are listed.
        changedDeletionLines: [3, 5],
        changedAdditionLines: [2, 5],
        contextLines: 1,
      }
    );
    expect(diff.neutralLines).toEqual({ deletions: [2] });
    // The row keeps its place in a change block: only that block can hold a
    // row with one side.
    expect(diff.hunks[0].hunkContent[1]).toEqual({
      type: 'change',
      deletions: 1,
      deletionLineIndex: 2,
      additions: 0,
      additionLineIndex: 2,
    });

    const allListed = createStructuralDiff(
      file('a.ts', oldLines),
      file('a.ts', newLines),
      {
        rows,
        changedDeletionLines: [2, 3, 5],
        changedAdditionLines: [2, 5],
      }
    );
    expect(allListed.neutralLines).toBeUndefined();
  });

  test('a format-only split has neutral rows only', () => {
    // One line became three; the host lists no changed line.
    const diff = createStructuralDiff(
      file('f.ts', ['const a = { b: 1, c: 2 };']),
      file('f.ts', ['const a = {', '  b: 1,', '  c: 2 };']),
      {
        rows: [
          [0, 0],
          [null, 1],
          [null, 2],
        ],
        changedDeletionLines: [],
        changedAdditionLines: [],
      }
    );
    expect(diff.neutralLines).toEqual({ additions: [1, 2] });
    expect(diff.hunks).toHaveLength(1);
  });

  for (const diffStyle of ['split', 'unified'] as const) {
    test(`neutral rows render as context in ${diffStyle} view`, async () => {
      const diff = createStructuralDiff(
        file('a.ts', oldLines),
        file('a.ts', newLines),
        {
          rows,
          changedDeletionLines: [3, 5],
          changedAdditionLines: [2, 5],
          contextLines: 1,
        }
      );
      const renderer = new DiffHunksRenderer({ diffStyle });
      const result = await renderer.asyncRender(diff);
      const elements = collectAllElements([
        ...(result.deletionsContentAST ?? []),
        ...(result.additionsContentAST ?? []),
        ...(result.unifiedContentAST ?? []),
      ]).filter((element) => element.properties?.['data-line'] != null);
      const typesByText = new Map<string, unknown>();
      for (const element of elements) {
        const text = collectAllElements([element])
          .flatMap((node) => node.children)
          .filter((node) => node.type === 'text')
          .map((node) => (node.type === 'text' ? node.value : ''))
          .join('')
          .trim();
        typesByText.set(text, element.properties?.['data-line-type']);
      }
      // The reformatted line: one side only, not changed, so it is context.
      expect(typesByText.get('items) {')).toBe('context');
      // Listed one-sided rows keep their change styling.
      expect(typesByText.get('const unused = 1;')).toBe('change-deletion');
      expect(typesByText.get('export const added = 2;')).toBe(
        'change-addition'
      );
      // A paired changed row is a change on both sides.
      expect(typesByText.get('return items.length;')).toBe('change-deletion');
      expect(typesByText.get('return items.size;')).toBe('change-addition');
    });
  }

  test('the gutter of a neutral row has no change type either', async () => {
    const diff = createStructuralDiff(
      file('f.ts', ['const a = { b: 1, c: 2 };']),
      file('f.ts', ['const a = {', '  b: 1,', '  c: 2 };']),
      {
        rows: [
          [0, 0],
          [null, 1],
          [null, 2],
        ],
        changedDeletionLines: [],
        changedAdditionLines: [],
      }
    );
    const renderer = new DiffHunksRenderer({ diffStyle: 'split' });
    const result = await renderer.asyncRender(diff);
    const lineTypes = collectAllElements([
      ...(result.additionsContentAST ?? []),
      ...(result.deletionsContentAST ?? []),
      ...(result.additionsGutterAST ?? []),
      ...(result.deletionsGutterAST ?? []),
    ])
      .map((element) => element.properties?.['data-line-type'])
      .filter((type) => type != null);
    expect(lineTypes.length).toBeGreaterThan(0);
    expect(lineTypes.every((type) => type === 'context')).toBe(true);
  });
});
