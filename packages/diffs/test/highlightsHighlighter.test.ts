import * as highlightsModule from '@pierre/highlights';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import type { ElementContent } from 'hast';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import prisma from 'shiki/langs/prisma.mjs';
import typescript from 'shiki/langs/typescript.mjs';

import { disposeHighlighter, parseDiffFromFile } from '../src';
import {
  createHighlightsHighlighter,
  type HighlightsHighlighter,
} from '../src/highlighter/highlights/createHighlightsHighlighter';
import {
  createRustCaptureRefiner,
  createScriptCaptureRefiner,
} from '../src/highlighter/highlights/refineScriptCaptures';
import type {
  HighlightsModule,
  HighlightsTheme,
  HighlightsThemeSet,
} from '../src/highlighter/highlights/types';
import type {
  DiffsHighlighter,
  FileDiffMetadata,
  RenderDiffOptions,
  ThemeRegistrationResolved,
} from '../src/types';
import { renderDiffWithHighlighter } from '../src/utils/renderDiffWithHighlighter';
import { renderFileWithHighlighter } from '../src/utils/renderFileWithHighlighter';
import type { RenderFileRequest } from '../src/worker/types';
import { collectAllElements } from './testUtils';
import {
  createInitializingManager,
  installAnimationFramePolyfill,
  respondToFileRequest,
  withTimeout,
} from './workerPoolHarness';

const lexers = highlightsModule as unknown as HighlightsModule;

const zed = (
  colors: Record<string, string>,
  italic: string[] = [],
  foreground = '#aaaaaa'
) =>
  ({
    name: 'zed',
    appearance: 'dark',
    style: {
      'editor.foreground': foreground,
      'editor.background': '#000000',
      syntax: Object.fromEntries(
        Object.entries(colors).map(([capture, color]) => [
          capture,
          italic.includes(capture)
            ? { color, font_style: 'italic' }
            : { color },
        ])
      ),
    },
  }) satisfies HighlightsTheme;

const DARK = zed(
  {
    comment: '#010101',
    'keyword.declaration': '#020202',
    string: '#030303',
    variable: '#040404',
    'variable.object': '#050505',
    property: '#060606',
    'property.access': '#070707',
    function: '#080808',
  },
  ['comment']
);
const LIGHT = zed({ comment: '#f1f1f1', string: '#f3f3f3' }, [], '#222222');

function textMate(
  name: string,
  type: 'dark' | 'light',
  highlights?: HighlightsThemeSet
): ThemeRegistrationResolved {
  return {
    name,
    type,
    fg: type === 'dark' ? '#aaaaaa' : '#222222',
    bg: type === 'dark' ? '#000000' : '#ffffff',
    settings: [
      { settings: { foreground: type === 'dark' ? '#aaaaaa' : '#222222' } },
      { scope: 'string', settings: { foreground: '#00ff00' } },
    ],
    colors: {},
    ...(highlights != null ? { highlights } : {}),
  };
}

const THEMES = [
  textMate('hl-dark', 'dark', { theme: DARK }),
  textMate('hl-light', 'light', { theme: LIGHT }),
];
const OPTIONS: RenderDiffOptions = {
  theme: { dark: 'hl-dark', light: 'hl-light' },
  useTokenTransformer: false,
  tokenizeMaxLineLength: 1000,
  lineDiffType: 'none',
  maxLineDiffLength: 1000,
};

const OLD = [
  '// a comment',
  'const greeting = "hello";',
  'session.files.get(key);',
  '',
].join('\n');
const NEW = [
  '// a comment',
  'const greeting = "world";',
  'session.files.get(key);',
  'const more = 1;',
  '',
].join('\n');

function tsDiff(name = 'example.ts'): FileDiffMetadata {
  return {
    ...parseDiffFromFile({ name, contents: OLD }, { name, contents: NEW }),
    intraLineRanges: {
      additions: { 1: [{ start: 18, end: 23 }] },
      deletions: { 1: [{ start: 18, end: 23 }] },
    },
  };
}

const textOf = (node: ElementContent): string =>
  node.type === 'text'
    ? node.value
    : node.type === 'element'
      ? node.children.map(textOf).join('')
      : '';

function spans(line: ElementContent | undefined) {
  return collectAllElements(line != null ? [line] : [])
    .filter(
      (element) =>
        element.tagName === 'span' &&
        typeof element.properties.style === 'string'
    )
    .map((element) => ({
      text: textOf(element),
      style: String(element.properties.style),
    }));
}

const lineShape = (lines: (ElementContent | undefined)[]) =>
  lines.map((line) =>
    line?.type === 'element'
      ? {
          text: textOf(line),
          tagName: line.tagName,
          line: line.properties['data-line'],
          alt: line.properties['data-alt-line'],
          type: line.properties['data-line-type'],
          index: line.properties['data-line-index'],
          diffSpans: collectAllElements([line])
            .filter((element) => element.properties['data-diff-span'] != null)
            .map(textOf),
        }
      : line
  );

describe("the 'highlights' highlighter", () => {
  let shiki: DiffsHighlighter;
  let highlights: HighlightsHighlighter;

  beforeAll(async () => {
    shiki = (await createHighlighterCore({
      themes: THEMES,
      langs: [typescript, prisma],
      engine: createJavaScriptRegexEngine(),
    })) as DiffsHighlighter;
    highlights = createHighlightsHighlighter(shiki, lexers);
    highlights.attachThemes(THEMES);
  });

  afterAll(() => {
    shiki.dispose();
  });

  test('a diff has the lines, the line attributes and the changed-token spans of the Shiki path', () => {
    const diff = tsDiff();
    const fromShiki = renderDiffWithHighlighter(diff, shiki, OPTIONS);
    const fromLexer = renderDiffWithHighlighter(
      diff,
      highlights.highlighter,
      OPTIONS
    );
    expect(lineShape(fromLexer.code.additionLines)).toEqual(
      lineShape(fromShiki.code.additionLines)
    );
    expect(lineShape(fromLexer.code.deletionLines)).toEqual(
      lineShape(fromShiki.code.deletionLines)
    );
    expect(fromLexer.themeStyles).toBe(fromShiki.themeStyles);
    expect(fromLexer.baseThemeType).toBe(fromShiki.baseThemeType);
    expect(lineShape(fromLexer.code.additionLines)[1]).toMatchObject({
      text: 'const greeting = "world";',
      type: 'change-addition',
      diffSpans: ['world'],
    });
  });

  test("a token has the colors of the themes' `highlights` themes, as the custom properties that Shiki writes", () => {
    const { code } = renderDiffWithHighlighter(
      tsDiff(),
      highlights.highlighter,
      OPTIONS
    );
    const [comment] = spans(code.additionLines[0]);
    expect(comment).toEqual({
      text: '// a comment',
      style:
        '--diffs-token-dark:#010101;--diffs-token-dark-font-style:italic;--diffs-token-light:#f1f1f1',
    });
    const second = spans(code.additionLines[1]);
    expect(second.find(({ text }) => text.trim() === 'const')?.style).toBe(
      '--diffs-token-dark:#020202;--diffs-token-light:#222222'
    );
    // The changed token is split at the range and keeps its color.
    expect(second.filter(({ text }) => text === 'world')).toEqual([
      {
        text: 'world',
        style: '--diffs-token-dark:#030303;--diffs-token-light:#f3f3f3',
      },
    ]);
    // Not the color of the TextMate rule: the tokens are the lexer's.
    expect(JSON.stringify(second)).not.toContain('#00ff00');
  });

  test('the refined captures have their own entries, and fall back to the capture of the lexer', () => {
    const { code } = renderDiffWithHighlighter(
      tsDiff(),
      highlights.highlighter,
      OPTIONS
    );
    const third = spans(code.additionLines[2]).map(({ text, style }) => [
      text,
      style.slice(
        '--diffs-token-dark:'.length,
        '--diffs-token-dark:'.length + 7
      ),
    ]);
    expect(third).toEqual([
      ['session', '#050505'],
      ['.', '#aaaaaa'],
      // `property.object` has no entry: the entry of `property`.
      ['files', '#060606'],
      ['.', '#aaaaaa'],
      ['get', '#080808'],
      ['(', '#aaaaaa'],
      ['key', '#040404'],
      [')', '#aaaaaa'],
      [';', '#aaaaaa'],
    ]);
  });

  test('one theme by name gives inline colors, as Shiki does', () => {
    const result = renderFileWithHighlighter(
      { name: 'a.ts', contents: '// note\nconst a = "b";\n' },
      highlights.highlighter,
      {
        theme: 'hl-dark',
        tokenizeMaxLineLength: 1000,
        useTokenTransformer: false,
      }
    );
    expect(spans(result.code[0])).toEqual([
      {
        text: '// note',
        style: 'color:#010101;font-style:italic',
      },
    ]);
    expect(result.code.length).toBe(3);
  });

  test('a language with no lexer goes to Shiki with its grammar', () => {
    expect(highlights.supports('prisma')).toBe(false);
    expect(highlights.supports('typescript')).toBe(true);
    expect(highlights.supports('vue')).toBe(true);
    expect(highlights.supports('text')).toBe(false);
    const file = {
      name: 'schema.prisma',
      contents: 'model User {\n  name String @default("x")\n}\n',
    };
    const options = {
      theme: { dark: 'hl-dark', light: 'hl-light' },
      tokenizeMaxLineLength: 1000,
      useTokenTransformer: false,
    };
    const fromLexer = renderFileWithHighlighter(
      file,
      highlights.highlighter,
      options
    );
    expect(fromLexer).toEqual(renderFileWithHighlighter(file, shiki, options));
    // The string has the color of the TextMate rule.
    expect(JSON.stringify(fromLexer.code).toLowerCase()).toContain('#00ff00');
  });

  test('an unknown extension is plain text', () => {
    const file = { name: 'notes.unknownext', contents: 'const a = 1;\n' };
    const options = {
      theme: { dark: 'hl-dark', light: 'hl-light' },
      tokenizeMaxLineLength: 1000,
      useTokenTransformer: false,
    };
    expect(
      renderFileWithHighlighter(file, highlights.highlighter, options)
    ).toEqual(renderFileWithHighlighter(file, shiki, options));
  });

  test('with a list of languages, only those are lexed', () => {
    const only = createHighlightsHighlighter(shiki, lexers, ['rust']);
    only.attachThemes(THEMES);
    expect(only.supports('rust')).toBe(true);
    expect(only.supports('typescript')).toBe(false);
    const file = { name: 'a.ts', contents: 'const a = "b";\n' };
    const options = {
      theme: { dark: 'hl-dark', light: 'hl-light' },
      tokenizeMaxLineLength: 1000,
      useTokenTransformer: false,
    };
    expect(renderFileWithHighlighter(file, only.highlighter, options)).toEqual(
      renderFileWithHighlighter(file, shiki, options)
    );
  });

  test('a theme with no `highlights` themes goes to Shiki', () => {
    const plain = textMate('hl-plain', 'dark');
    shiki.loadThemeSync(plain);
    highlights.attachThemes([plain]);
    const file = { name: 'a.ts', contents: 'const a = "b";\n' };
    const options = {
      theme: { dark: 'hl-plain', light: 'hl-light' },
      tokenizeMaxLineLength: 1000,
      useTokenTransformer: false,
    };
    const result = renderFileWithHighlighter(
      file,
      highlights.highlighter,
      options
    );
    expect(result).toEqual(renderFileWithHighlighter(file, shiki, options));
    expect(JSON.stringify(result.code).toLowerCase()).toContain('#00ff00');
  });

  test('a line at the length limit is one token with the foreground', () => {
    const long = `const a = "${'x'.repeat(40)}";`;
    const result = renderFileWithHighlighter(
      { name: 'a.ts', contents: `${long}\nconst b = 1;\n` },
      highlights.highlighter,
      {
        theme: { dark: 'hl-dark', light: 'hl-light' },
        tokenizeMaxLineLength: 30,
        useTokenTransformer: false,
      }
    );
    expect(spans(result.code[0])).toEqual([
      {
        text: long,
        style: '--diffs-token-dark:#aaaaaa;--diffs-token-light:#222222',
      },
    ]);
    expect(spans(result.code[1])[0]?.style).toContain('#020202');
  });

  test('CRLF line ends give the lines of the Shiki path', () => {
    const file = { name: 'a.ts', contents: 'const a = 1;\r\nconst b = 2;\r\n' };
    const options = {
      theme: { dark: 'hl-dark', light: 'hl-light' },
      tokenizeMaxLineLength: 1000,
      useTokenTransformer: false,
    };
    expect(
      lineShape(
        renderFileWithHighlighter(file, highlights.highlighter, options).code
      )
    ).toEqual(lineShape(renderFileWithHighlighter(file, shiki, options).code));
  });
});

describe('the capture refiners', () => {
  const refine = (lang: 'tsx' | 'rust', code: string) => {
    const probe = {
      name: 'probe',
      appearance: 'dark',
      style: {
        'editor.foreground': '#ffffff',
        syntax: Object.fromEntries(
          lexers.tokenNames.map((name, index) => [
            name,
            { color: `#${index.toString(16).padStart(6, '0')}` },
          ])
        ),
      },
    };
    const refiner =
      lang === 'rust'
        ? createRustCaptureRefiner()
        : createScriptCaptureRefiner();
    const out: string[] = [];
    for (const line of lexers.codeToTokens(code, {
      lang,
      theme: probe,
    }).tokens) {
      const tokens = line.map(({ content, color }) => ({
        content,
        capture:
          lexers.tokenNames[parseInt((color ?? '#0').slice(1), 16)] ?? '',
      }));
      refiner.line(tokens);
      expect(tokens.map(({ content }) => content).join('')).toBe(
        line.map(({ content }) => content).join('')
      );
      out.push(
        ...tokens
          .filter(({ content }) => content.trim() !== '')
          .map(({ content, capture }) => `${content.trim()}:${capture}`)
      );
    }
    return out;
  };

  test('script: objects, properties, imports, constants, type arguments and JSX braces', () => {
    expect(refine('tsx', 'import { a, type B } from "x";')).toEqual([
      'import:keyword.import',
      '{:punctuation.bracket',
      'a:variable.import',
      ',:punctuation.delimiter',
      'type:keyword.import',
      'B:variable.import',
      '}:punctuation.bracket',
      'from:keyword.import',
      '"x":string',
      ';:punctuation.delimiter',
    ]);
    expect(refine('tsx', 'const n = a.b.c;')).toEqual([
      'const:keyword.declaration',
      'n:constant',
      '=:operator.assignment',
      'a:variable.object',
      '.:punctuation.delimiter',
      'b:property.object',
      '.:punctuation.delimiter',
      'c:property.access',
      ';:punctuation.delimiter',
    ]);
    expect(refine('tsx', 'let m: Map<string, Foo[]> | undefined;')).toEqual([
      'let:keyword.declaration',
      'm:variable',
      '::punctuation.special',
      'Map:type',
      '<:punctuation.bracket.type',
      'string:type.builtin',
      ',:punctuation.delimiter',
      'Foo:type',
      '[]:punctuation.bracket',
      '>:punctuation.bracket.type',
      '|:operator.type',
      'undefined:type.builtin.value',
      ';:punctuation.delimiter',
    ]);
    expect(
      refine(
        'tsx',
        'const v = <A title={t} on={() => f({ k: 1 })}>{n}</A>;'
      ).filter((entry) => /^[{}()]+:/.test(entry))
    ).toEqual([
      '{:punctuation.bracket.embedded',
      '}:punctuation.bracket.embedded',
      '{:punctuation.bracket.embedded',
      '():punctuation.bracket',
      '({:punctuation.bracket',
      '}):punctuation.bracket',
      '}:punctuation.bracket.embedded',
      '{:punctuation.bracket.embedded',
      '}:punctuation.bracket.embedded',
    ]);
  });

  test('rust: everything in an attribute is the attribute', () => {
    expect(refine('rust', '#[derive(Debug, Clone)]\nstruct A;')).toEqual([
      '#:attribute',
      '[:attribute',
      'derive:attribute',
      '(:attribute',
      'Debug:attribute',
      ',:attribute',
      'Clone:attribute',
      ')]:attribute',
      'struct:keyword.declaration',
      'A:type',
      ';:punctuation.delimiter',
    ]);
  });
});

describe("a worker pool with the 'highlights' highlighter", () => {
  let restoreAnimationFrame: () => void;
  beforeAll(() => {
    restoreAnimationFrame = installAnimationFramePolyfill();
  });
  afterAll(() => {
    restoreAnimationFrame();
  });
  afterEach(async () => {
    await disposeHighlighter();
  });

  test('sends no grammar for a language that the workers lex, and sends one for the others', async () => {
    const { initialization, manager, worker } = createInitializingManager({
      preferredHighlighter: 'highlights',
    });
    try {
      const request = await worker.waitForInitializeRequest();
      expect(request.preferredHighlighter).toBe('highlights');
      worker.respond({
        type: 'success',
        requestType: 'initialize',
        id: request.id,
        highlightsLanguages: ['typescript'],
        sentAt: Date.now(),
      });
      await withTimeout(initialization);

      const posted: RenderFileRequest[] = [];
      const next = () =>
        new Promise<RenderFileRequest>((resolve) => {
          const original = worker.postMessage.bind(worker);
          worker.postMessage = (message) => {
            original(message);
            if (message.type === 'file') {
              posted.push(structuredClone(message));
              resolve(posted.at(-1)!);
            }
          };
        });
      let wait = next();
      const first = manager.primeFileHighlightCache({
        name: 'a.ts',
        contents: 'const a = 1;',
        cacheKey: 'a',
      });
      let fileRequest = await withTimeout(wait);
      expect(fileRequest.resolvedLanguages).toBeUndefined();
      respondToFileRequest(manager, worker, fileRequest);
      await withTimeout(first);

      wait = next();
      const second = manager.primeFileHighlightCache({
        name: 'schema.prisma',
        contents: 'model User {}',
        cacheKey: 'b',
      });
      fileRequest = await withTimeout(wait);
      expect(fileRequest.resolvedLanguages?.map(({ name }) => name)).toEqual([
        'prisma',
      ]);
      respondToFileRequest(manager, worker, fileRequest);
      await withTimeout(second);
    } finally {
      manager.terminate();
    }
  });
});
