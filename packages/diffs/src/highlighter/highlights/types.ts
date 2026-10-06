// The 'highlights' highlighter: the WebAssembly lexers of @pierre/highlights
// in the worker pool. The package is not a dependency of @pierre/diffs: the
// host gives its module to the worker (`provideHighlights` of
// worker-portable.js), and its themes ride on the registered themes.

/** A color and font settings of one capture name, as a Zed theme has them. */
export interface HighlightsSyntaxStyle {
  color?: string;
  font_style?: string;
  font_weight?: number;
}

/** A Zed theme: the fields that the 'highlights' highlighter reads. */
export interface HighlightsTheme {
  name: string;
  appearance?: string;
  style: {
    'editor.foreground'?: string;
    text?: string;
    foreground?: string;
    /**
     * Capture name → style. A name with no entry has the style of the name
     * with its last segment removed (`variable.object` → `variable`), then the
     * foreground.
     */
    syntax?: Record<string, string | HighlightsSyntaxStyle>;
    [key: string]: unknown;
  };
}

/**
 * The themes of one registered theme for the 'highlights' highlighter: set it
 * as the `highlights` property of the theme that `registerCustomTheme` loads.
 */
export interface HighlightsThemeSet {
  theme: HighlightsTheme;
  /** A theme for one language (by its name in this package), over `theme`. */
  languages?: Record<string, HighlightsTheme>;
}

export interface HighlightsLexedToken {
  content: string;
  offset: number;
  color?: string;
}

/**
 * The part of the module of @pierre/highlights that the worker calls. The
 * options are `{ lang, theme, tokenizeMaxLineLength }`; their types are the
 * module's own, so they are not repeated here.
 */
export interface HighlightsModule {
  codeToTokens: (
    input: string,
    options: never
  ) => { tokens: HighlightsLexedToken[][] };
  isSupportedLanguage: (lang: string) => boolean;
  tokenNames: readonly string[];
}
