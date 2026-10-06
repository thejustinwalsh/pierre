// The lexers of @pierre/highlights give one capture name to text that a
// TextMate grammar splits: `property` is an object key, a member of a type and
// a property access; `variable` is a name, an object before a dot and a name
// in an import. A TextMate theme can color each of those differently. This
// pass reads the tokens next to a token and gives it a more exact capture
// name, so a theme can style it as the TextMate grammar would.
//
// A refined name extends the lexer's name with a dot (`variable.object`), so a
// theme with no entry for it falls back to the lexer's name.
//
// For TypeScript, TSX, JavaScript and JSX only.

export interface CaptureToken {
  content: string;
  capture: string;
}

export interface ScriptCaptureRefiner {
  /** Refines the tokens of the next line of the file, in place. */
  line(tokens: CaptureToken[]): void;
}

const PRIMITIVE_TYPES = new Set([
  'any',
  'bigint',
  'boolean',
  'never',
  'number',
  'object',
  'string',
  'symbol',
  'unknown',
]);

const OPERATORS: Record<string, string> = {
  '=>': 'operator.arrow',
  '...': 'operator.spread',
  '=': 'operator.assignment',
  '+=': 'operator.assignment',
  '-=': 'operator.assignment',
  '*=': 'operator.assignment',
  '/=': 'operator.assignment',
  '%=': 'operator.assignment',
  '??=': 'operator.assignment',
  '||=': 'operator.assignment',
  '&&=': 'operator.assignment',
  '|=': 'operator.assignment',
  '&=': 'operator.assignment',
  '==': 'operator.comparison',
  '===': 'operator.comparison',
  '!=': 'operator.comparison',
  '!==': 'operator.comparison',
  '<': 'operator.relational',
  '>': 'operator.relational',
  '<=': 'operator.relational',
  '>=': 'operator.relational',
  '&&': 'operator.logical',
  '||': 'operator.logical',
  '??': 'operator.logical',
  '!': 'operator.logical',
  '!!': 'operator.logical',
  '+': 'operator.arithmetic',
  '-': 'operator.arithmetic',
  '*': 'operator.arithmetic',
  '/': 'operator.arithmetic',
  '%': 'operator.arithmetic',
  '**': 'operator.arithmetic',
  '++': 'operator.increment',
  '--': 'operator.increment',
  '?': 'operator.ternary',
  '|': 'operator.type',
  '&': 'operator.type',
};

const TYPE_CAPTURES = new Set([
  'type',
  'type.builtin',
  'type.class',
  'type.builtin.value',
]);

// After a type colon, `|`, `&`, `=>`, or `as`, `is`, `extends`, `keyof`.
const TYPE_KEYWORDS = new Set(['as', 'is', 'extends', 'keyof', 'satisfies']);
function inTypePosition(previous: CaptureToken | undefined): boolean {
  if (previous == null) return false;
  const text = previous.content.trim();
  return (
    previous.capture === 'punctuation.special' ||
    previous.capture === 'operator.type' ||
    previous.capture === 'operator.arrow' ||
    previous.capture === 'punctuation.bracket.type' ||
    (previous.capture === 'keyword' && TYPE_KEYWORDS.has(text))
  );
}

const startsWithDot = (token: CaptureToken | undefined): boolean =>
  token != null &&
  token.capture === 'punctuation.delimiter' &&
  (token.content.startsWith('?.') ||
    (token.content.startsWith('.') && !token.content.startsWith('..')));

const endsWithDot = (token: CaptureToken | undefined): boolean => {
  if (token == null || token.capture !== 'punctuation.delimiter') return false;
  return token.content.endsWith('.') && !token.content.endsWith('..');
};

/**
 * A refiner for one file. It keeps state from line to line (an import list
 * and a `const` declaration can span lines), so give it every line in order.
 */
export function createScriptCaptureRefiner(): ScriptCaptureRefiner {
  // Inside `import … from` or `export { … }`: every name is an alias.
  let inImport = false;
  // Between `const` and the `=` of its declaration: every name is a constant.
  let inConst = false;
  // One entry for each open `{`: true for the brace of a JSX expression.
  const braces: boolean[] = [];
  // The capture of the token before, over line ends.
  let lastCapture = '';
  // Open `<` of type arguments.
  let typeDepth = 0;
  return {
    line(tokens) {
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        const text = token.content.trim();
        if (text === '') continue;
        const previous = tokens[index - 1];
        const next = tokens[index + 1];
        switch (token.capture) {
          case 'keyword.import':
            if (text === 'import') {
              const after = next?.content.trimStart() ?? '';
              inImport = !after.startsWith('(') && !after.startsWith('.');
            } else if (text === 'export') {
              const after = next?.content.trim();
              const afterType = tokens[index + 2]?.content.trimStart() ?? '';
              inImport =
                after?.startsWith('{') === true ||
                after === '*' ||
                (after === 'type' && afterType.startsWith('{'));
            } else if (text === 'from') {
              inImport = false;
            }
            inConst = false;
            break;
          case 'keyword.declaration':
            if (inImport && text === 'type') token.capture = 'keyword.import';
            else inImport = false;
            inConst = text === 'const';
            break;
          case 'variable':
            if (inImport) {
              // `import type { … }`: the lexer gives this `type` a name.
              token.capture =
                text === 'type' ? 'keyword.import' : 'variable.import';
            } else if (
              PRIMITIVE_TYPES.has(text) &&
              !startsWithDot(next) &&
              (typeDepth > 0 || inTypePosition(previous))
            ) {
              // `string` as a type: after a type colon, in a union, in type
              // arguments. Elsewhere it is a name (`{ kind, number }`).
              token.capture = 'type.builtin';
            } else if (startsWithDot(next)) {
              token.capture = 'variable.object';
            } else if (inConst) {
              token.capture = 'constant';
            }
            break;
          case 'type':
          case 'constant':
            if (inImport) token.capture = 'variable.import';
            break;
          case 'punctuation.special':
            // The braces of `${…}` in a template string.
            if (text === '${' || text === '}') {
              token.capture = 'punctuation.special.template';
            }
            break;
          case 'punctuation.bracket':
            index += splitEmbeddedBraces(tokens, index, braces, lastCapture);
            break;
          case 'property':
            if (endsWithDot(previous)) {
              token.capture = startsWithDot(next)
                ? 'property.object'
                : 'property.access';
            } else if (next?.capture === 'punctuation.special') {
              token.capture = 'property.definition';
            }
            break;
          case 'constant.builtin': {
            // `null` and `undefined` as types: after a type colon, or in a union.
            const before = previous?.content.trim();
            if (
              previous?.capture === 'punctuation.special' ||
              (previous?.capture.startsWith('operator') === true &&
                before === '|') ||
              (next?.capture === 'operator' && next.content.trim() === '|')
            ) {
              token.capture = 'type.builtin.value';
            }
            break;
          }
          case 'keyword':
            if (text === 'void' && previous != null) {
              const before = previous.content.trim();
              if (
                previous.capture === 'punctuation.special' ||
                before.endsWith(':') ||
                before === '=>' ||
                before === '|'
              ) {
                token.capture = 'type.builtin';
              }
            }
            break;
          case 'operator': {
            // The lexer joins operators that have only spaces between them
            // (`> | `): one token for each, then this token again.
            if (/\S\s+\S/.test(token.content)) {
              const parts = token.content.match(/\s*\S+\s*/g) ?? [];
              tokens.splice(
                index,
                1,
                ...parts.map((content) => ({ content, capture: 'operator' }))
              );
              index--;
              continue;
            }
            if (
              text === '<' &&
              previous != null &&
              !/\s$/.test(previous.content) &&
              /[\w$]$/.test(previous.content)
            ) {
              // `Map<`: the start of type arguments has no space before it.
              token.capture = 'punctuation.bracket.type';
              typeDepth++;
            } else if (
              /^>+$/.test(text) &&
              previous != null &&
              (TYPE_CAPTURES.has(previous.capture) ||
                /[\]>}"']\s*$/.test(previous.content)) &&
              !/\s$/.test(previous.content)
            ) {
              token.capture = 'punctuation.bracket.type';
              typeDepth = Math.max(0, typeDepth - text.length);
            } else {
              const refined = OPERATORS[text];
              if (refined != null) token.capture = refined;
              if (inConst && refined === 'operator.assignment') inConst = false;
            }
            break;
          }
          case 'punctuation.delimiter':
            if (text.includes(';')) {
              inImport = false;
              inConst = false;
              typeDepth = 0;
            } else if (text === ':' && previous?.capture === 'property') {
              token.capture = 'punctuation.delimiter.key';
            }
            break;
          case 'keyword.control':
            inConst = false;
            break;
          default:
            break;
        }
        lastCapture = tokens[index].capture;
        // `for (const x of list)`: the declaration has no `=`.
        if (
          inConst &&
          token.capture === 'keyword' &&
          (text === 'of' || text === 'in')
        ) {
          inConst = false;
        }
      }
    },
  };
}

const BEFORE_JSX_EXPRESSION = new Set([
  'punctuation.delimiter.jsx',
  'punctuation.bracket.jsx',
  'punctuation.bracket.embedded',
  'text.jsx',
  'tag.jsx',
  'tag.component.jsx',
]);

/**
 * Finds the braces of JSX expressions (`title={name}`, `<b>{count}</b>`) in a
 * bracket token. The lexer joins adjacent brackets into one token (`{() `), so
 * the token is split where the kind of bracket changes. Returns the number of
 * tokens added.
 */
function splitEmbeddedBraces(
  tokens: CaptureToken[],
  index: number,
  braces: boolean[],
  lastCapture: string
): number {
  const { content } = tokens[index];
  if (!content.includes('{') && !content.includes('}')) return 0;
  const parts: CaptureToken[] = [];
  for (let at = 0; at < content.length; at++) {
    const char = content[at];
    let embedded = false;
    if (char === '{') {
      const before = parts.at(-1)?.capture ?? lastCapture;
      embedded = at === 0 ? BEFORE_JSX_EXPRESSION.has(before) : false;
      braces.push(embedded);
    } else if (char === '}') {
      embedded = braces.pop() ?? false;
    }
    const capture = embedded
      ? 'punctuation.bracket.embedded'
      : 'punctuation.bracket';
    const last = parts.at(-1);
    // Whitespace stays with the bracket before it.
    if (last != null && (last.capture === capture || char.trim() === '')) {
      last.content += char;
    } else {
      parts.push({ content: char, capture });
    }
  }
  if (parts.length === 1 && parts[0].capture === 'punctuation.bracket')
    return 0;
  tokens.splice(index, 1, ...parts);
  return parts.length - 1;
}

/**
 * Rust: everything inside an attribute (`#[derive(Debug)]`) is the attribute,
 * as in the TextMate grammar.
 */
export function createRustCaptureRefiner(): ScriptCaptureRefiner {
  let depth = 0;
  let pending = false;
  return {
    line(tokens) {
      for (const token of tokens) {
        const text = token.content.trim();
        if (depth === 0 && !pending) {
          if (
            token.capture === 'attribute' &&
            (text === '#' || text === '#!')
          ) {
            pending = true;
          }
          continue;
        }
        if (token.capture === 'punctuation.bracket') {
          for (const char of token.content) {
            if (char === '[') depth++;
            else if (char === ']') depth--;
          }
          pending = false;
          token.capture = 'attribute';
          if (depth <= 0) depth = 0;
          continue;
        }
        if (pending) {
          // `#` with no bracket after it is not an attribute.
          pending = false;
          continue;
        }
        if (text !== '') token.capture = 'attribute';
      }
    },
  };
}
