import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, FileDiff, parseDiffFromFile } from '../src';
import type { DiffLineAnnotation, RenderRange } from '../src/types';
import { installDom } from './domHarness';

afterAll(async () => {
  await disposeHighlighter();
});

async function waitForRenderedCode(container: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (container.shadowRoot?.querySelector('code') != null) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for FileDiff render');
}

const range = (startingLine: number, totalLines: number): RenderRange => ({
  startingLine,
  totalLines,
  bufferBefore: 0,
  bufferAfter: 0,
});

// One row per content child of a column: `line:<n>`, `annotation`, `buffer`.
function rows(container: HTMLElement, side: 'additions' | 'deletions') {
  const content = container.shadowRoot?.querySelector(
    `[data-${side}] [data-content]`
  );
  return Array.from(content?.children ?? []).map((child) => {
    const { dataset } = child as HTMLElement;
    if ('lineAnnotation' in dataset) return 'annotation';
    if ('contentBuffer' in dataset) return 'buffer';
    return `line:${dataset.line}`;
  });
}

describe('FileDiff partial render keeps the annotation of the last line', () => {
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
  const oldFile = { name: 'x.txt', contents: `${lines.join('\n')}\n` };
  const newFile = {
    name: 'x.txt',
    contents: `${lines.map((line, index) => (index === 5 ? 'changed' : line)).join('\n')}\n`,
  };
  const lineAnnotations: DiffLineAnnotation<string>[] = [
    { side: 'additions', lineNumber: 6, metadata: 'on the changed line' },
  ];

  for (const diffStyle of ['split', 'unified'] as const) {
    // The window moves up so that the annotated line is the last line that
    // stays: the trim of the rows after it must not take its annotation row,
    // which a full render of the same range has.
    test(`${diffStyle}: a narrower range that ends at an annotated line renders as a full render of that range`, async () => {
      const { cleanup } = installDom();
      let partial: FileDiff<string> | undefined;
      let full: FileDiff<string> | undefined;
      try {
        const fileDiff = parseDiffFromFile(oldFile, newFile);
        // Find the row index of the annotated line from a full render.
        const probeContainer = document.createElement('div');
        full = new FileDiff<string>({
          disableErrorHandling: true,
          disableFileHeader: true,
          diffStyle,
          expandUnchanged: true,
        });
        full.render({
          fileContainer: probeContainer,
          fileDiff,
          lineAnnotations,
          deferManagers: true,
          preventEmit: true,
          renderRange: range(0, 100),
        });
        await waitForRenderedCode(probeContainer);
        const side = diffStyle === 'split' ? 'additions' : 'additions';
        const column = (container: HTMLElement) =>
          diffStyle === 'split'
            ? rows(container, side)
            : Array.from(
                container.shadowRoot?.querySelector('[data-unified] [data-content]')
                  ?.children ?? []
              ).map((child) => {
                const { dataset } = child as HTMLElement;
                return 'lineAnnotation' in dataset
                  ? 'annotation'
                  : `line:${dataset.line}`;
              });
        const all = column(probeContainer);
        const annotationAt = all.indexOf('annotation');
        expect(annotationAt).toBeGreaterThan(0);
        // Lines before the annotation row: the window ends with the annotated line.
        const end = all.slice(0, annotationAt).length;

        const fileContainer = document.createElement('div');
        partial = new FileDiff<string>({
          disableErrorHandling: true,
          disableFileHeader: true,
          diffStyle,
          expandUnchanged: true,
        });
        partial.render({
          fileContainer,
          fileDiff,
          lineAnnotations,
          deferManagers: true,
          preventEmit: true,
          renderRange: range(2, end + 2),
        });
        await waitForRenderedCode(fileContainer);
        expect(column(fileContainer)).toContain('annotation');

        // The window moves two lines up: two lines leave at the end, and the
        // annotated line is now the last one.
        partial.render({
          fileContainer,
          fileDiff,
          lineAnnotations,
          deferManagers: true,
          preventEmit: true,
          renderRange: range(0, end),
        });
        const after = column(fileContainer);

        const expectedContainer = document.createElement('div');
        const expected = new FileDiff<string>({
          disableErrorHandling: true,
          disableFileHeader: true,
          diffStyle,
          expandUnchanged: true,
        });
        expected.render({
          fileContainer: expectedContainer,
          fileDiff,
          lineAnnotations,
          deferManagers: true,
          preventEmit: true,
          renderRange: range(0, end),
        });
        await waitForRenderedCode(expectedContainer);
        const wanted = column(expectedContainer);
        expected.cleanUp();

        expect(wanted.at(-1)).toBe('annotation');
        expect(after).toEqual(wanted);
      } finally {
        partial?.cleanUp();
        full?.cleanUp();
        cleanup();
      }
    });
  }
});
