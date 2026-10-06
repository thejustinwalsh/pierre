import type { ThemedToken } from 'shiki';

import type {
  CodeToHastOptions,
  DiffsHighlighter,
  DiffsThemeNames,
  ShikiTransformer,
  SupportedLanguages,
  ThemeRegistrationResolved,
} from '../../types';
import {
  type CaptureToken,
  createRustCaptureRefiner,
  createScriptCaptureRefiner,
  type ScriptCaptureRefiner,
} from './refineScriptCaptures';
import type {
  HighlightsModule,
  HighlightsSyntaxStyle,
  HighlightsTheme,
  HighlightsThemeSet,
} from './types';

const SCRIPT_LANGUAGES = new Set([
  'typescript',
  'ts',
  'mts',
  'cts',
  'tsx',
  'javascript',
  'js',
  'mjs',
  'cjs',
  'jsx',
]);
const RUST_LANGUAGES = new Set(['rust', 'rs']);

export interface HighlightsHighlighter {
  /** A Shiki highlighter whose `codeToHast` lexes with @pierre/highlights. */
  highlighter: DiffsHighlighter;
  /** Reads the `highlights` themes of resolved themes. */
  attachThemes(themes: ThemeRegistrationResolved[]): void;
  /** True for a language that the lexers cover: it needs no Shiki grammar. */
  supports(lang: SupportedLanguages | undefined): boolean;
}

interface ResolvedStyle {
  color: string;
  italic: boolean;
  bold: boolean;
}

/**
 * Wraps a Shiki highlighter. For a language that @pierre/highlights has a
 * lexer for, and themes that carry `highlights` themes, `codeToHast` takes its
 * tokens from the lexer and gives them to Shiki's own token → HAST step, so
 * transformers, decorations and the shape of the result are Shiki's. Every
 * other call goes to the Shiki highlighter: a language with no lexer, or a
 * theme with no `highlights` themes.
 */
export function createHighlightsHighlighter(
  base: DiffsHighlighter,
  module: HighlightsModule,
  /** Only these languages are lexed; every other one goes to Shiki. */
  onlyLanguages?: readonly string[]
): HighlightsHighlighter {
  const allowed = onlyLanguages != null ? new Set(onlyLanguages) : undefined;
  const themeSets = new Map<string, HighlightsThemeSet>();
  const { tokenNames } = module;
  // A theme that gives each capture its own color: the color of a lexed token
  // is the index of its capture name.
  const probeSyntax: Record<string, HighlightsSyntaxStyle> = {};
  const captureByColor = new Map<string, string>();
  for (const [index, name] of tokenNames.entries()) {
    if (index === 0 || name === 'background' || name === 'foreground') continue;
    const color = `#${index.toString(16).padStart(6, '0')}`;
    probeSyntax[name] = { color };
    captureByColor.set(color, name);
  }
  const probe: HighlightsTheme = {
    name: 'pierre-diffs-captures',
    appearance: 'dark',
    style: {
      'editor.foreground': '#ffffff',
      'editor.background': '#000000',
      syntax: probeSyntax,
    },
  };
  // Theme → capture name → style. Dropped when the themes change.
  let styleCache = new WeakMap<HighlightsTheme, Map<string, ResolvedStyle>>();

  function styleOf(theme: HighlightsTheme, capture: string): ResolvedStyle {
    let styles = styleCache.get(theme);
    if (styles == null) {
      styles = new Map();
      styleCache.set(theme, styles);
    }
    let style = styles.get(capture);
    if (style == null) {
      style = resolveStyle(theme, capture);
      styles.set(capture, style);
    }
    return style;
  }

  function supports(lang: SupportedLanguages | undefined): boolean {
    return (
      lang != null &&
      lang !== 'text' &&
      lang !== 'ansi' &&
      (allowed == null || allowed.has(lang)) &&
      module.isSupportedLanguage(lang)
    );
  }

  function lex(
    code: string,
    lang: string,
    tokenizeMaxLineLength: number | undefined
  ): CaptureToken[][] {
    const options = { lang, theme: probe, tokenizeMaxLineLength };
    const { tokens } = module.codeToTokens(code, options as never);
    const refiner: ScriptCaptureRefiner | undefined = SCRIPT_LANGUAGES.has(lang)
      ? createScriptCaptureRefiner()
      : RUST_LANGUAGES.has(lang)
        ? createRustCaptureRefiner()
        : undefined;
    const lines: CaptureToken[][] = new Array(tokens.length);
    for (let index = 0; index < tokens.length; index++) {
      const lexed = tokens[index];
      const line: CaptureToken[] = new Array(lexed.length);
      for (let at = 0; at < lexed.length; at++) {
        const { content, color } = lexed[at];
        line[at] = {
          content,
          capture:
            (color != null ? captureByColor.get(color) : undefined) ?? '',
        };
      }
      refiner?.line(line);
      lines[index] = line;
    }
    return lines;
  }

  const highlighter: DiffsHighlighter = Object.create(base) as DiffsHighlighter;
  highlighter.codeToHast = (code, options) => {
    const { lang } = options;
    const themeOption = getThemeOption(options);
    if (themeOption == null || !supports(lang)) {
      return base.codeToHast(code, options);
    }
    const themes: [key: string | undefined, theme: HighlightsTheme][] = [];
    for (const [key, name] of themeOption) {
      const set = themeSets.get(name);
      if (set == null) {
        // A theme with no `highlights` themes: Shiki, with the grammar when
        // the worker has it.
        return base.codeToHast(code, {
          ...options,
          lang: base.getLoadedLanguages().includes(lang) ? lang : 'text',
        });
      }
      themes.push([key, set.languages?.[lang] ?? set.theme]);
    }
    const prefix =
      ('cssVariablePrefix' in options
        ? options.cssVariablePrefix
        : undefined) ?? '--shiki-';
    const styleByCapture = new Map<string, Partial<ThemedToken>>();
    const tokenStyle = (capture: string): Partial<ThemedToken> => {
      let style = styleByCapture.get(capture);
      if (style == null) {
        style = themedStyle(themes, capture, prefix, styleOf);
        styleByCapture.set(capture, style);
      }
      return style;
    };
    const lines = lex(code, lang, options.tokenizeMaxLineLength);
    const inject: ShikiTransformer = {
      name: 'pierre-diffs-highlights',
      enforce: 'pre',
      tokens(plain) {
        // The lines must be Shiki's lines: a difference would move every row.
        if (plain.length !== lines.length) return undefined;
        const themed: ThemedToken[][] = new Array(lines.length);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          let offset = plain[index][0]?.offset ?? 0;
          const out: ThemedToken[] = new Array(line.length);
          for (let at = 0; at < line.length; at++) {
            const { content, capture } = line[at];
            out[at] = { content, offset, ...tokenStyle(capture) };
            offset += content.length;
          }
          themed[index] = out;
        }
        return themed;
      },
    };
    return base.codeToHast(code, {
      ...options,
      lang: 'text',
      transformers: [inject, ...(options.transformers ?? [])],
    });
  };

  return {
    highlighter,
    supports,
    attachThemes(themes) {
      for (const theme of themes) {
        const set = (theme as { highlights?: unknown }).highlights;
        if (isThemeSet(set)) themeSets.set(theme.name, set);
        else themeSets.delete(theme.name);
      }
      styleCache = new WeakMap();
    },
  };
}

function getThemeOption(
  options: CodeToHastOptions<DiffsThemeNames>
): [key: string | undefined, name: string][] | undefined {
  if ('themes' in options && options.themes != null) {
    const out: [string, string][] = [];
    for (const [key, name] of Object.entries(options.themes)) {
      if (typeof name !== 'string') return undefined;
      out.push([key, name]);
    }
    return out;
  }
  if ('theme' in options && typeof options.theme === 'string') {
    return [[undefined, options.theme]];
  }
  return undefined;
}

function isThemeSet(value: unknown): value is HighlightsThemeSet {
  if (value == null || typeof value !== 'object') return false;
  const { theme } = value as { theme?: unknown };
  return (
    theme != null &&
    typeof theme === 'object' &&
    typeof (theme as HighlightsTheme).style === 'object' &&
    (theme as HighlightsTheme).style != null
  );
}

const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// The style of a capture name: its own entry, then the entry of each shorter
// name, then the foreground. Font settings come from the nearest entry that
// has them. Only hex colors: the value goes into a style attribute.
function resolveStyle(theme: HighlightsTheme, capture: string): ResolvedStyle {
  const { style } = theme;
  const syntax = style.syntax ?? {};
  let color: string | undefined;
  let fontStyle: string | undefined;
  let fontWeight: number | undefined;
  for (let name = capture; name !== ''; ) {
    const entry = syntax[name];
    if (typeof entry === 'string') {
      color ??= entry;
    } else if (entry != null) {
      color ??= entry.color;
      fontStyle ??= entry.font_style;
      fontWeight ??= entry.font_weight;
    }
    if (color != null) break;
    const dot = name.lastIndexOf('.');
    name = dot < 0 ? '' : name.slice(0, dot);
  }
  const foreground =
    style['editor.foreground'] ?? style.text ?? style.foreground;
  if (color == null || !COLOR.test(color)) color = foreground;
  return {
    color: color != null && COLOR.test(color) ? color.toLowerCase() : 'inherit',
    italic: fontStyle === 'italic',
    bold: fontWeight != null && fontWeight >= 600,
  };
}

// The style fields of a token, in the form that Shiki gives them: `color` and
// `fontStyle` for one theme, and for several themes the custom properties that
// Shiki writes with `defaultColor: false`.
function themedStyle(
  themes: [key: string | undefined, theme: HighlightsTheme][],
  capture: string,
  prefix: string,
  styleOf: (theme: HighlightsTheme, capture: string) => ResolvedStyle
): Partial<ThemedToken> {
  if (themes.length === 1 && themes[0][0] === undefined) {
    const style = styleOf(themes[0][1], capture);
    return {
      color: style.color,
      fontStyle: (style.italic ? 1 : 0) | (style.bold ? 2 : 0),
    };
  }
  const htmlStyle: Record<string, string> = {};
  for (const [key, theme] of themes) {
    const style = styleOf(theme, capture);
    htmlStyle[`${prefix}${key}`] = style.color;
    if (style.italic) htmlStyle[`${prefix}${key}-font-style`] = 'italic';
    if (style.bold) htmlStyle[`${prefix}${key}-font-weight`] = 'bold';
  }
  return { htmlStyle };
}
