import { describe, expect, test } from 'bun:test';

import { DiffHunksRenderer, parseDiffFromFile } from '../src';
import type { FileDiffMetadata, FileIntraLineRanges } from '../src/types';
import { collectAllElements } from './testUtils';

function diffSpanElements(
  result: Awaited<ReturnType<DiffHunksRenderer['asyncRender']>>
) {
  const additions = result.additionsContentAST ?? [];
  const deletions = result.deletionsContentAST ?? [];
  return [
    ...collectAllElements(additions),
    ...collectAllElements(deletions),
  ].filter((element) => element.properties?.['data-diff-span'] != null);
}

function withRanges(
  diff: FileDiffMetadata,
  ranges: FileIntraLineRanges
): FileDiffMetadata {
  return { ...diff, intraLineRanges: ranges };
}

const sampleOld = {
  name: 'example.ts',
  contents: 'const greeting = "hello";\n',
};
const sampleNew = {
  name: 'example.ts',
  contents: 'const greeting = "world";\n',
};

describe('FileDiffMetadata.intraLineRanges', () => {
  test('supplied ranges render as data-diff-span decorations', async () => {
    const renderer = new DiffHunksRenderer({ diffStyle: 'split' });
    const diff = withRanges(parseDiffFromFile(sampleOld, sampleNew), {
      additions: { 0: [{ end: 23, start: 18 }] },
      deletions: { 0: [{ end: 23, start: 18 }] },
    });

    const result = await renderer.asyncRender(diff);
    expect(diffSpanElements(result).length).toBe(2);
  });

  test('per-file ranges suppress the default char/word diff', async () => {
    const renderer = new DiffHunksRenderer({ diffStyle: 'split' });
    const diff = withRanges(parseDiffFromFile(sampleOld, sampleNew), {});

    const result = await renderer.asyncRender(diff);
    expect(diffSpanElements(result).length).toBe(0);
  });

  test('drops degenerate ranges where end <= start', async () => {
    const renderer = new DiffHunksRenderer({ diffStyle: 'split' });
    const diff = withRanges(parseDiffFromFile(sampleOld, sampleNew), {
      additions: {
        0: [
          { end: 5, start: 5 },
          { end: 0, start: 5 },
          { end: 23, start: 18 },
        ],
      },
    });

    const result = await renderer.asyncRender(diff);
    expect(diffSpanElements(result).length).toBe(1);
  });

  test('files without intraLineRanges keep the options-level lineDiffType behavior', async () => {
    const renderer = new DiffHunksRenderer({
      diffStyle: 'split',
      lineDiffType: 'char',
    });
    const diff = parseDiffFromFile(sampleOld, sampleNew);

    const result = await renderer.asyncRender(diff);
    expect(diffSpanElements(result).length).toBeGreaterThan(0);
  });
});
