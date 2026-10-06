import { describe, expect, test } from 'bun:test';

import { CodeView } from '../src/components/CodeView';
import { DEFAULT_THEMES } from '../src/constants';
import { installDom } from './domHarness';

describe('CodeView overscrollSize option', () => {
  test('defaults to 200 pixels', () => {
    const { cleanup } = installDom();
    try {
      expect(new CodeView().config.overscrollSize).toBe(200);
      expect(
        new CodeView({ theme: DEFAULT_THEMES }).config.overscrollSize
      ).toBe(200);
    } finally {
      cleanup();
    }
  });

  test('takes the option at construction and on setOptions', () => {
    const { cleanup } = installDom();
    try {
      const viewer = new CodeView({
        theme: DEFAULT_THEMES,
        overscrollSize: 600,
      });
      expect(viewer.config.overscrollSize).toBe(600);
      viewer.setOptions({ theme: DEFAULT_THEMES, overscrollSize: 0 });
      expect(viewer.config.overscrollSize).toBe(0);
      viewer.setOptions({ theme: DEFAULT_THEMES });
      expect(viewer.config.overscrollSize).toBe(200);
    } finally {
      cleanup();
    }
  });

  test('ignores a value that is not a size', () => {
    const { cleanup } = installDom();
    try {
      for (const overscrollSize of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          new CodeView({ theme: DEFAULT_THEMES, overscrollSize }).config
            .overscrollSize
        ).toBe(200);
      }
    } finally {
      cleanup();
    }
  });
});
