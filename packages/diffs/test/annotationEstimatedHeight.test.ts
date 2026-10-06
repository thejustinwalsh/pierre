import { describe, expect, test } from 'bun:test';
import type { ElementContent, Element as HASTElement } from 'hast';

import { DiffHunksRenderer, disposeHighlighter } from '../src';
import { CodeView } from '../src/components/CodeView';
import { ResizeManager } from '../src/managers/ResizeManager';
import type {
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
} from '../src/types';
import { parseDiffFromFile } from '../src/utils/parseDiffFromFile';
import { createRoot, installDom, makeFile, renderItems } from './domHarness';

// A 40-line file with line 20 changed: the rows of lines 17 to 23 render, the
// lines before and after are collapsed.
function makeDiff(name: string): FileDiffMetadata {
  const oldFile = makeFile(name, 40);
  const lines = oldFile.contents.split('\n');
  lines[19] = 'line 20 changed';
  return parseDiffFromFile(oldFile, { name, contents: lines.join('\n') });
}

function makeItems(
  annotations?: DiffLineAnnotation<undefined>[]
): CodeViewItem<undefined>[] {
  // Enough items before the two that are compared, so neither is mounted.
  return Array.from({ length: 60 }, (_, index) => ({
    id: `item:${index}`,
    type: 'diff' as const,
    fileDiff: makeDiff(`file${index}.ts`),
    ...(index === 50 && annotations != null ? { annotations } : {}),
  }));
}

async function roomOfItem50(
  annotations?: DiffLineAnnotation<undefined>[]
): Promise<number> {
  const viewer = new CodeView<undefined>();
  viewer.setup(createRoot());
  try {
    await renderItems(viewer, makeItems(annotations));
    const rendered = viewer.getRenderedItems().map((item) => item.id);
    expect(rendered).not.toContain('item:50');
    return (
      (viewer.getTopForItem('item:51') ?? 0) -
      (viewer.getTopForItem('item:50') ?? 0)
    );
  } finally {
    viewer.cleanUp();
  }
}

describe('DiffLineAnnotation.estimatedHeight', () => {
  test('a file that is not mounted counts its annotation rows before it measures them', async () => {
    const { cleanup } = installDom();
    try {
      const plain = await roomOfItem50();
      // No estimate: the annotation rows have no height until they are measured.
      expect(
        await roomOfItem50([
          { side: 'additions', lineNumber: 20 },
          { side: 'deletions', lineNumber: 18 },
        ])
      ).toBe(plain);

      // Two annotations on one line and side add up; the other line has its own row.
      expect(
        await roomOfItem50([
          { side: 'additions', lineNumber: 20, estimatedHeight: 26 },
          { side: 'additions', lineNumber: 20, estimatedHeight: 10 },
          { side: 'deletions', lineNumber: 18, estimatedHeight: 40 },
        ])
      ).toBe(plain + 36 + 40);

      // A split row holds both sides of a line: it takes the taller one.
      expect(
        await roomOfItem50([
          { side: 'additions', lineNumber: 20, estimatedHeight: 26 },
          { side: 'deletions', lineNumber: 20, estimatedHeight: 40 },
        ])
      ).toBe(plain + 40);

      // A line inside a collapsed region has no row, a file-level annotation
      // is not a line, and a size that is not positive is no estimate.
      expect(
        await roomOfItem50([
          { side: 'additions', lineNumber: 2, estimatedHeight: 26 },
          { side: 'additions', lineNumber: 0, estimatedHeight: 26 },
          { side: 'additions', lineNumber: 20, estimatedHeight: 0 },
          { side: 'additions', lineNumber: 21, estimatedHeight: -4 },
        ])
      ).toBe(plain);
    } finally {
      cleanup();
    }
  });

  test('annotations that change replace the estimates of the annotations before', async () => {
    const { cleanup } = installDom();
    try {
      const viewer = new CodeView<undefined>();
      viewer.setup(createRoot());
      const room = () =>
        (viewer.getTopForItem('item:51') ?? 0) -
        (viewer.getTopForItem('item:50') ?? 0);
      const items = makeItems();
      await renderItems(viewer, items);
      const plain = room();

      viewer.updateItem({
        ...(items[50] as CodeViewDiffItem<undefined>),
        version: 1,
        annotations: [
          { side: 'additions', lineNumber: 20, estimatedHeight: 26 },
        ],
      });
      viewer.render(true);
      expect(room()).toBe(plain + 26);

      viewer.updateItem({
        ...(items[50] as CodeViewDiffItem<undefined>),
        version: 2,
        annotations: [
          { side: 'additions', lineNumber: 22, estimatedHeight: 52 },
        ],
      });
      viewer.render(true);
      expect(room()).toBe(plain + 52);

      viewer.updateItem({
        ...(items[50] as CodeViewDiffItem<undefined>),
        version: 3,
        annotations: [],
      });
      viewer.render(true);
      expect(room()).toBe(plain);
      viewer.cleanUp();
    } finally {
      cleanup();
    }
  });

  test('the annotation row has the estimate as its least height from its first render', async () => {
    const renderer = new DiffHunksRenderer<undefined>({ diffStyle: 'split' });
    try {
      renderer.setLineAnnotations([
        { side: 'additions', lineNumber: 20, estimatedHeight: 26 },
        { side: 'deletions', lineNumber: 20, estimatedHeight: 40 },
        { side: 'additions', lineNumber: 22 },
      ]);
      const result = await renderer.asyncRender(makeDiff('rows.ts'));
      const rows = [
        ...(result.additionsContentAST ?? []),
        ...(result.deletionsContentAST ?? []),
      ].filter(
        (node: ElementContent): node is HASTElement =>
          node.type === 'element' &&
          node.properties['data-line-annotation'] != null
      );
      // Both rows of the pair of line 20 take the taller side; the pair of
      // line 22 has no estimate and no style.
      expect(
        rows.map((row) => [
          row.properties['data-annotation-estimate'],
          row.properties.style,
        ])
      ).toEqual([
        ['40', '--diffs-annotation-min-height:40px'],
        [undefined, undefined],
        ['40', '--diffs-annotation-min-height:40px'],
        [undefined, undefined],
      ]);
    } finally {
      await disposeHighlighter();
    }
  });

  test('the resize manager keeps the estimate when the content is shorter, and grows past it', () => {
    const { cleanup } = installDom();
    try {
      const pre = document.createElement('pre');
      const heights = new Map<Element, number>();
      const column = (estimate: string | undefined) => {
        const code = document.createElement('code');
        const gutter = document.createElement('div');
        const content = document.createElement('div');
        const row = document.createElement('div');
        row.setAttribute('data-line-annotation', '0,3');
        if (estimate != null) {
          row.setAttribute('data-annotation-estimate', estimate);
        }
        const child = document.createElement('div');
        Object.defineProperty(child, 'getBoundingClientRect', {
          value: () => ({ height: heights.get(child) ?? 0 }),
        });
        row.appendChild(child);
        content.appendChild(row);
        code.append(gutter, content);
        pre.appendChild(code);
        return { row, child };
      };
      const first = column('26');
      const second = column('26');
      // The slotted content is not in yet: both children have no height.
      const manager = new ResizeManager();
      manager.setup(pre, { disableAnnotations: false });
      const minHeight = (row: HTMLElement) =>
        row.style.getPropertyValue('--diffs-annotation-min-height');
      expect([minHeight(first.row), minHeight(second.row)]).toEqual([
        '26px',
        '26px',
      ]);

      // Content taller than the estimate: the pair grows to it.
      heights.set(first.child, 48);
      manager.cleanUp();
      const again = new ResizeManager();
      again.setup(pre, { disableAnnotations: false });
      expect([minHeight(first.row), minHeight(second.row)]).toEqual([
        '48px',
        '48px',
      ]);
      again.cleanUp();
    } finally {
      cleanup();
    }
  });
});
