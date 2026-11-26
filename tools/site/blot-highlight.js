// Blot 2 syntax highlighter aligned with `tree-sitter-blot2/grammar.js`
// and `queries/highlights.scm`. Lossless: plain text output always equals input.

const KEYWORDS = new Set([
  'import', 'from', 'as', 'data', 'type', 'is', 'effect', 'const', 'let', 'use',
  'func', 'rec', 'own', 'if', 'then', 'else', 'case', 'of', 'for', 'in',
  'continue', 'return', 'break', 'yield', 'panic', 'do', 'fork', 'with',
  'freeze', 'seal', 'copy', 'spark', 'expect_trap',
  'infixl', 'infixr', 'infix', 'prefix',
]);

const WORD_OPS = new Set(['and', 'or', 'not']);
const BOOLEANS = new Set(['true', 'false']);
const STAGING_MARKERS = new Set(['#run', '#do', '#for', '#if', '#else', '#fields', '#variants']);
const HASH_MODIFIERS = new Set(['#kernel', '#process']);
const PRIVATE_TARGETS = new Set(['io', 'func', 'const', 'let', 'type', 'data', 'effect', 'impl']);
const CONTRACT_TARGETS = new Set(['contract', 'trait', 'opaque']);

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderStringLiteral(raw) {
  let out = '';
  let i = 0;
  const n = raw.length;
  while (i < n) {
    if (raw[i] === '\\' && i + 1 < n && /[ntr"\\]/.test(raw[i + 1])) {
      out += `<span class="tok-esc">${escapeHtml(raw.slice(i, i + 2))}</span>`;
      i += 2;
    } else {
      let end = i + 1;
      while (end < n && !(raw[end] === '\\' && end + 1 < n && /[ntr"\\]/.test(raw[end + 1]))) {
        end++;
      }
      out += escapeHtml(raw.slice(i, end));
      i = end;
    }
  }
  return `<span class="tok-str">${out}</span>`;
}

function renderBacktickInfix(raw) {
  if (raw.length < 3 || raw[0] !== '`' || raw[raw.length - 1] !== '`') {
    return `<span class="tok-op">${escapeHtml(raw)}</span>`;
  }
  const inner = raw.slice(1, -1);
  const parts = inner.split('.');
  let body = '';
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) body += '<span class="tok-punc">.</span>';
    const part = parts[i];
    const isLast = i === parts.length - 1;
    const cls = isLast ? 'tok-fn' : (/^[A-Z]/.test(part) ? 'tok-ty' : 'tok-ns');
    body += `<span class="${cls}">${escapeHtml(part)}</span>`;
  }
  return `<span class="tok-op">\`</span>${body}<span class="tok-op">\`</span>`;
}

export function tokenizeBlot(source) {
  const tokens = [];
  const n = source.length;
  let i = 0;

  while (i < n) {
    const ch = source[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      let end = i + 1;
      while (end < n && (source[end] === ' ' || source[end] === '\t' || source[end] === '\r' || source[end] === '\n')) {
        end++;
      }
      const raw = source.slice(i, end);
      tokens.push({ kind: 'ws', raw, hasNl: raw.includes('\n') });
      i = end;
      continue;
    }

    // Line comment
    if (ch === '/' && source[i + 1] === '/') {
      let end = i + 2;
      while (end < n && source[end] !== '\r' && source[end] !== '\n') end++;
      tokens.push({ kind: 'com', raw: source.slice(i, end) });
      i = end;
      continue;
    }

    // Single-line string literal
    if (ch === '"') {
      let end = i + 1;
      while (end < n && source[end] !== '"' && source[end] !== '\r' && source[end] !== '\n') {
        if (source[end] === '\\' && end + 1 < n && source[end + 1] !== '\r' && source[end + 1] !== '\n') {
          end += 2;
        } else {
          end++;
        }
      }
      if (end < n && source[end] === '"') end++;
      tokens.push({ kind: 'str', raw: source.slice(i, end) });
      i = end;
      continue;
    }

    // Backtick infix function
    if (ch === '`') {
      let end = i + 1;
      while (end < n && source[end] !== '`' && source[end] !== '\r' && source[end] !== '\n') end++;
      if (end < n && source[end] === '`') end++;
      tokens.push({ kind: 'bt', raw: source.slice(i, end) });
      i = end;
      continue;
    }

    // Hash modifier or staging directive (#kernel, #process, #run, #if, ...)
    if (ch === '#' && i + 1 < n && /[a-z_]/.test(source[i + 1])) {
      let end = i + 1;
      while (end < n && /[a-zA-Z0-9_]/.test(source[end])) end++;
      const raw = source.slice(i, end);
      if (HASH_MODIFIERS.has(raw) || STAGING_MARKERS.has(raw)) {
        tokens.push({ kind: 'dir', raw });
        i = end;
        continue;
      }
    }

    // Intrinsic @name.path (not attribute @[...])
    if (ch === '@' && i + 1 < n && /[a-z_]/.test(source[i + 1])) {
      let end = i + 1;
      while (end < n && /[a-z0-9_]/.test(source[end])) end++;
      while (end + 1 < n && source[end] === '.' && /[A-Za-z_]/.test(source[end + 1])) {
        end++;
        while (end < n && /[A-Za-z0-9_]/.test(source[end])) end++;
      }
      tokens.push({ kind: 'int', raw: source.slice(i, end) });
      i = end;
      continue;
    }

    // Number literal (hex, float, decimal with optional _)
    if (ch >= '0' && ch <= '9') {
      let end = i + 1;
      if (ch === '0' && (source[end] === 'x' || source[end] === 'X') && end + 1 < n && /[0-9A-Fa-f]/.test(source[end + 1])) {
        end += 2;
        while (end < n && /[0-9A-Fa-f_]/.test(source[end])) end++;
      } else {
        while (end < n && /[0-9_]/.test(source[end])) end++;
        if (source[end] === '.' && end + 1 < n && source[end + 1] >= '0' && source[end + 1] <= '9') {
          end++;
          while (end < n && /[0-9_]/.test(source[end])) end++;
        }
        if ((source[end] === 'e' || source[end] === 'E') && end + 1 < n) {
          let exp = end + 1;
          if (source[exp] === '+' || source[exp] === '-') exp++;
          if (exp < n && source[exp] >= '0' && source[exp] <= '9') {
            end = exp + 1;
            while (end < n && /[0-9_]/.test(source[end])) end++;
          }
        }
      }
      tokens.push({ kind: 'num', raw: source.slice(i, end) });
      i = end;
      continue;
    }

    // Type identifier (PascalCase)
    if (ch >= 'A' && ch <= 'Z') {
      let end = i + 1;
      while (end < n && /[A-Za-z0-9_]/.test(source[end])) end++;
      tokens.push({ kind: 'ty', raw: source.slice(i, end) });
      i = end;
      continue;
    }

    // Lowercase identifier / keyword
    if ((ch >= 'a' && ch <= 'z') || ch === '_') {
      let end = i + 1;
      while (end < n && /[A-Za-z0-9_]/.test(source[end])) end++;
      tokens.push({ kind: 'id', raw: source.slice(i, end) });
      i = end;
      continue;
    }

    // Spread / range / multi-char operators
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'op', raw: '...' });
      i += 3;
      continue;
    }
    if (ch === '.' && source[i + 1] === '.') {
      tokens.push({ kind: 'op', raw: '..' });
      i += 2;
      continue;
    }
    if ((ch === ':' && source[i + 1] === '=') || (ch === '=' && source[i + 1] === '>') || (ch === '-' && source[i + 1] === '>')) {
      tokens.push({ kind: 'op', raw: source.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if (ch === '$' || /[+\-*/%=!<>|&^~?]/.test(ch)) {
      if (ch === '$') {
        tokens.push({ kind: 'op', raw: '$' });
        i++;
        continue;
      }
      let end = i + 1;
      while (end < n && /[+\-*/%=!<>|&^~?]/.test(source[end])) {
        // Don't swallow `//` comment starts inside operator runs
        if (source[end] === '/' && source[end + 1] === '/') break;
        end++;
      }
      tokens.push({ kind: 'op', raw: source.slice(i, end) });
      i = end;
      continue;
    }

    // Punctuation
    tokens.push({ kind: 'punc', raw: ch });
    i++;
  }

  return tokens;
}

export function highlightBlot(source) {
  const tokens = tokenizeBlot(source);
  const len = tokens.length;
  const cls = new Array(len).fill('');

  const isTrivia = (idx) => tokens[idx].kind === 'ws' || tokens[idx].kind === 'com';
  const nextSig = (idx) => {
    let k = idx + 1;
    while (k < len && isTrivia(k)) k++;
    return k < len ? k : -1;
  };
  const prevSig = (idx) => {
    let k = idx - 1;
    while (k >= 0 && isTrivia(k)) k--;
    return k;
  };
  const nextSameLine = (idx) => {
    let k = idx + 1;
    while (k < len && tokens[k].kind === 'ws' && !tokens[k].hasNl) k++;
    return k < len && tokens[k].kind !== 'com' && !(tokens[k].kind === 'ws' && tokens[k].hasNl) ? k : -1;
  };
  const atLineStart = (idx) => {
    let k = idx - 1;
    while (k >= 0 && tokens[k].kind === 'ws' && !tokens[k].hasNl) k--;
    return k < 0 || (tokens[k].kind === 'ws' && tokens[k].hasNl);
  };
  const findClose = (openIdx, openCh, closeCh) => {
    let depth = 1;
    for (let k = openIdx + 1; k < len; k++) {
      if (tokens[k].kind === 'punc') {
        if (tokens[k].raw === openCh) depth++;
        else if (tokens[k].raw === closeCh) {
          depth--;
          if (depth === 0) return k;
        }
      }
    }
    return -1;
  };

  // Mark parameter patterns (`x`, `(x: T)`, `(own x: T)`) across a curried `->` chain.
  const markParams = (startIdx) => {
    let k = startIdx;
    while (k >= 0 && k < len) {
      const t = tokens[k];
      if (t.kind === 'ws') {
        if (t.hasNl) break;
        k++;
        continue;
      }
      if (t.kind === 'com') break;
      if (t.kind === 'op' && (t.raw === '=>' || t.raw === '=')) break;
      if (t.kind === 'punc' && t.raw === ':') break;
      if (t.kind === 'id' && t.raw === 'where') break;
      if (t.kind === 'id' && !KEYWORDS.has(t.raw) && !BOOLEANS.has(t.raw) && !WORD_OPS.has(t.raw)) {
        cls[k] = 'tok-param';
        const after = nextSameLine(k);
        if (after !== -1 && tokens[after].kind === 'op' && tokens[after].raw === '->') {
          k = after + 1;
          continue;
        }
        break;
      }
      if (t.kind === 'punc' && t.raw === '(') {
        const close = findClose(k, '(', ')');
        if (close === -1) break;
        const first = nextSig(k);
        if (first !== -1 && first < close) {
          if (tokens[first].kind === 'id' && tokens[first].raw === 'own') {
            cls[first] = 'tok-kw';
            const second = nextSig(first);
            if (second !== -1 && second < close && tokens[second].kind === 'id') {
              cls[second] = 'tok-param';
            }
          } else if (tokens[first].kind === 'id' && !KEYWORDS.has(tokens[first].raw)) {
            cls[first] = 'tok-param';
          }
        }
        const after = nextSameLine(close);
        if (after !== -1 && tokens[after].kind === 'op' && tokens[after].raw === '->') {
          k = after + 1;
          continue;
        }
        break;
      }
      if (t.kind === 'punc' && (t.raw === '{' || t.raw === '[')) {
        const close = findClose(k, t.raw, t.raw === '{' ? '}' : ']');
        if (close === -1) break;
        const after = nextSameLine(close);
        if (after !== -1 && tokens[after].kind === 'op' && tokens[after].raw === '->') {
          k = after + 1;
          continue;
        }
        break;
      }
      break;
    }
  };

  // Detect whether an `io` token starts an `io` function header (`io name params =>`).
  const isIoFunctionHeader = (ioIdx) => {
    const first = nextSameLine(ioIdx);
    if (first === -1 || (tokens[first].kind !== 'id' && tokens[first].kind !== 'ty')) return false;
    if (tokens[first].raw === 'const' || tokens[first].raw === 'let') return false;
    // Scan the same line (allowing balanced parens/brackets/braces) for `=>`
    let depth = 0;
    let sawParam = false;
    let k = first;
    // Skip optional qualified name `Mod.name`
    while (k + 2 < len && tokens[k + 1].kind === 'punc' && tokens[k + 1].raw === '.' && (tokens[k + 2].kind === 'id' || tokens[k + 2].kind === 'ty')) {
      k += 2;
    }
    for (let j = k + 1; j < len; j++) {
      const tj = tokens[j];
      if (tj.kind === 'ws') {
        if (tj.hasNl && depth === 0) return false;
        continue;
      }
      if (tj.kind === 'com') return false;
      if (tj.kind === 'punc') {
        if (tj.raw === '(' || tj.raw === '[' || tj.raw === '{') {
          if (depth === 0) sawParam = true;
          depth++;
        } else if (tj.raw === ')' || tj.raw === ']' || tj.raw === '}') {
          depth = Math.max(0, depth - 1);
        }
        continue;
      }
      if (depth === 0 && tj.kind === 'op' && tj.raw === '=>') {
        return sawParam;
      }
      if (depth === 0) sawParam = true;
    }
    return false;
  };

  // Pass 2a: base classes
  for (let i = 0; i < len; i++) {
    const t = tokens[i];
    if (t.kind === 'com') cls[i] = 'tok-com';
    else if (t.kind === 'num') cls[i] = 'tok-num';
    else if (t.kind === 'int') cls[i] = 'tok-int';
    else if (t.kind === 'ty') cls[i] = 'tok-ty';
    else if (t.kind === 'punc') cls[i] = 'tok-punc';
    else if (t.kind === 'op') cls[i] = 'tok-op';
    else if (t.kind === 'dir') cls[i] = HASH_MODIFIERS.has(t.raw) ? 'tok-kw' : 'tok-dir';
    else if (t.kind === 'id') {
      if (BOOLEANS.has(t.raw)) cls[i] = 'tok-bool';
      else if (t.raw === 'self') cls[i] = 'tok-self';
      else if (WORD_OPS.has(t.raw)) cls[i] = 'tok-kw';
      else if (KEYWORDS.has(t.raw)) cls[i] = 'tok-kw';
    }
  }

  // Pass 2b: contextual Blot 2 syntax rules
  const braceStack = []; // 'rec' | 'other'
  for (let i = 0; i < len; i++) {
    const t = tokens[i];

    // Track brace contexts for record fields (`{ field: val }`) vs effect/where rows
    if (t.kind === 'punc' && t.raw === '{') {
      const p = prevSig(i);
      const isNonRec =
        p !== -1 &&
        ((tokens[p].kind === 'id' && (tokens[p].raw === 'import' || tokens[p].raw === 'export' || tokens[p].raw === 'where')) ||
          (tokens[p].kind === 'op' && tokens[p].raw === '!'));
      braceStack.push(isNonRec ? 'other' : 'rec');
      continue;
    }
    if (t.kind === 'punc' && t.raw === '}') {
      braceStack.pop();
      continue;
    }

    // Declaration tags: `@[callee ...]` (allow `@[test.suite]`, exclude `@[func ...]`)
    if (t.kind === 'punc' && t.raw === '@' && i + 1 < len && tokens[i + 1].kind === 'punc' && tokens[i + 1].raw === '[') {
      cls[i] = 'tok-punc';
      const c = nextSig(i + 1);
      if (c !== -1 && (tokens[c].kind === 'id' || tokens[c].kind === 'ty') && tokens[c].raw !== 'func') {
        cls[c] = 'tok-attr';
        let k = c;
        while (k + 2 < len && tokens[k + 1].kind === 'punc' && tokens[k + 1].raw === '.' && (tokens[k + 2].kind === 'id' || tokens[k + 2].kind === 'ty')) {
          cls[k + 2] = 'tok-attr';
          k += 2;
        }
      }
      continue;
    }

    // Constructors: `$Some`, `$events.PointerMove`, `$d2.Circle`
    if (t.kind === 'op' && t.raw === '$') {
      const p = prevSig(i);
      // Forward break `break $ ...`
      if (p !== -1 && tokens[p].kind === 'id' && tokens[p].raw === 'break') {
        cls[i] = 'tok-punc';
        continue;
      }
      if (i + 1 < len && (tokens[i + 1].kind === 'id' || tokens[i + 1].kind === 'ty')) {
        let k = i + 1;
        const segs = [k];
        while (k + 2 < len && tokens[k + 1].kind === 'punc' && tokens[k + 1].raw === '.' && (tokens[k + 2].kind === 'id' || tokens[k + 2].kind === 'ty')) {
          k += 2;
          segs.push(k);
        }
        const last = segs[segs.length - 1];
        if (tokens[last].kind === 'ty') {
          cls[i] = 'tok-con';
          for (let s = 0; s < segs.length - 1; s++) {
            cls[segs[s]] = tokens[segs[s]].kind === 'ty' ? 'tok-ty' : 'tok-ns';
          }
          cls[last] = 'tok-con';
        }
      }
      continue;
    }

    if (t.kind !== 'id') continue;

    // Import alias (`import * as test from "std/test"`) overrides keyword coloring on the alias name.
    if (t.raw === 'as') {
      const n1 = nextSameLine(i);
      if (n1 !== -1 && tokens[n1].kind === 'id') cls[n1] = 'tok-ns';
      continue;
    }

    // Contextual `test "name":` / `test expect_trap "name":` (not `import * as test` or `test.eq`)
    if (t.raw === 'test') {
      const n1 = nextSameLine(i);
      if (n1 !== -1 && (tokens[n1].kind === 'str' || (tokens[n1].kind === 'id' && tokens[n1].raw === 'expect_trap'))) {
        cls[i] = 'tok-kw';
      }
      continue;
    }

    // Contextual `export { ... } from`
    if (t.raw === 'export') {
      const n1 = nextSig(i);
      if (n1 !== -1 && tokens[n1].kind === 'punc' && tokens[n1].raw === '{') cls[i] = 'tok-kw';
      continue;
    }

    // Contextual `where { ... }`
    if (t.raw === 'where') {
      const n1 = nextSig(i);
      if (n1 !== -1 && tokens[n1].kind === 'punc' && tokens[n1].raw === '{') cls[i] = 'tok-kw';
      continue;
    }

    // Contextual `for ever:`
    if (t.raw === 'ever') {
      const p = prevSig(i);
      const n1 = nextSig(i);
      if (p !== -1 && tokens[p].kind === 'id' && tokens[p].raw === 'for' && n1 !== -1 && tokens[n1].kind === 'punc' && tokens[n1].raw === ':') {
        cls[i] = 'tok-kw';
      }
      continue;
    }

    // Contextual `is contract =` / `is trait =` / `is opaque =`
    if (CONTRACT_TARGETS.has(t.raw)) {
      const p = prevSig(i);
      const n1 = nextSig(i);
      if (p !== -1 && tokens[p].kind === 'id' && tokens[p].raw === 'is' && n1 !== -1 && tokens[n1].kind === 'op' && tokens[n1].raw === '=') {
        cls[i] = 'tok-kw';
      }
      continue;
    }

    // Contextual `impl TypeName`
    if (t.raw === 'impl') {
      const n1 = nextSameLine(i);
      if (n1 !== -1 && tokens[n1].kind === 'ty') cls[i] = 'tok-kw';
      continue;
    }

    // Contextual `complete pat =>`
    if (t.raw === 'complete' && atLineStart(i)) {
      let depth = 0;
      for (let j = i + 1; j < len; j++) {
        if (tokens[j].kind === 'ws' && tokens[j].hasNl && depth === 0) break;
        if (tokens[j].kind === 'punc') {
          if (tokens[j].raw === '(' || tokens[j].raw === '[' || tokens[j].raw === '{') depth++;
          else if (tokens[j].raw === ')' || tokens[j].raw === ']' || tokens[j].raw === '}') depth = Math.max(0, depth - 1);
        } else if (depth === 0 && tokens[j].kind === 'op' && tokens[j].raw === '=>') {
          cls[i] = 'tok-kw';
          markParams(i + 1);
          break;
        }
      }
      continue;
    }

    // Contextual `private` modifier
    if (t.raw === 'private') {
      const n1 = nextSameLine(i);
      if (n1 !== -1 && tokens[n1].kind === 'id' && PRIVATE_TARGETS.has(tokens[n1].raw)) {
        if (tokens[n1].raw === 'io') {
          const n2 = nextSameLine(n1);
          if ((n2 !== -1 && (tokens[n2].raw === 'const' || tokens[n2].raw === 'let')) || isIoFunctionHeader(n1)) {
            cls[i] = 'tok-kw';
          }
        } else {
          cls[i] = 'tok-kw';
        }
      }
      continue;
    }

    // Contextual `io` entry modifier (`io const`, `io let`, `io fn ... =>`)
    if (t.raw === 'io') {
      const n1 = nextSameLine(i);
      if (n1 !== -1 && tokens[n1].kind === 'id' && (tokens[n1].raw === 'const' || tokens[n1].raw === 'let')) {
        cls[i] = 'tok-kw';
      } else if (isIoFunctionHeader(i)) {
        cls[i] = 'tok-kw';
        let k = n1;
        const segs = [k];
        while (k + 2 < len && tokens[k + 1].kind === 'punc' && tokens[k + 1].raw === '.' && (tokens[k + 2].kind === 'id' || tokens[k + 2].kind === 'ty')) {
          k += 2;
          segs.push(k);
        }
        for (let s = 0; s < segs.length - 1; s++) {
          cls[segs[s]] = tokens[segs[s]].kind === 'ty' ? 'tok-ty' : 'tok-ns';
        }
        cls[segs[segs.length - 1]] = 'tok-fn';
        markParams(segs[segs.length - 1] + 1);
      }
      continue;
    }

    // Type declarations (`type Maybe a is ...` / `=> type a`)
    if (t.raw === 'type' || t.raw === 'data') {
      const n1 = nextSameLine(i);
      if (n1 !== -1 && tokens[n1].kind === 'ty') {
        const n2 = nextSameLine(n1);
        if (n2 !== -1 && tokens[n2].kind === 'id' && !KEYWORDS.has(tokens[n2].raw) && !cls[n2]) {
          cls[n2] = 'tok-param';
        }
      } else if (n1 !== -1 && tokens[n1].kind === 'id' && !KEYWORDS.has(tokens[n1].raw) && !cls[n1]) {
        const p = prevSig(i);
        if (p !== -1 && tokens[p].kind === 'op' && tokens[p].raw === '=>') {
          cls[n1] = 'tok-param';
        }
      }
      continue;
    }

    // Named function headers (`func name param...`) vs lambdas (`func param =>`)
    if (t.raw === 'func') {
      const n1 = nextSameLine(i);
      if (n1 === -1) continue;
      if (tokens[n1].kind === 'id' || tokens[n1].kind === 'ty') {
        let k = n1;
        const segs = [k];
        while (k + 2 < len && tokens[k + 1].kind === 'punc' && tokens[k + 1].raw === '.' && (tokens[k + 2].kind === 'id' || tokens[k + 2].kind === 'ty')) {
          k += 2;
          segs.push(k);
        }
        const afterName = nextSameLine(k);
        const isLambda =
          segs.length === 1 &&
          (afterName === -1 ||
            (tokens[afterName].kind === 'op' && (tokens[afterName].raw === '=>' || tokens[afterName].raw === '->')) ||
            (tokens[afterName].kind === 'punc' && tokens[afterName].raw === ':'));
        if (isLambda) {
          markParams(n1);
        } else {
          for (let s = 0; s < segs.length - 1; s++) {
            cls[segs[s]] = tokens[segs[s]].kind === 'ty' ? 'tok-ty' : 'tok-ns';
          }
          cls[segs[segs.length - 1]] = 'tok-fn';
          markParams(k + 1);
        }
      } else {
        markParams(n1);
      }
      continue;
    }

    // Function binding: `const name = func ...` / `let name = func ...`
    if (t.raw === 'const' || t.raw === 'let') {
      const n1 = nextSameLine(i);
      if (n1 !== -1 && (tokens[n1].kind === 'id' || tokens[n1].kind === 'ty')) {
        let k = n1;
        const segs = [k];
        while (k + 2 < len && tokens[k + 1].kind === 'punc' && tokens[k + 1].raw === '.' && (tokens[k + 2].kind === 'id' || tokens[k + 2].kind === 'ty')) {
          k += 2;
          segs.push(k);
        }
        // Scan past optional `: annotation` to `=` on the same line
        let eqIdx = -1;
        let depth = 0;
        for (let j = k + 1; j < len; j++) {
          if (tokens[j].kind === 'ws' && tokens[j].hasNl && depth === 0) break;
          if (tokens[j].kind === 'punc') {
            if (tokens[j].raw === '(' || tokens[j].raw === '[' || tokens[j].raw === '{') depth++;
            else if (tokens[j].raw === ')' || tokens[j].raw === ']' || tokens[j].raw === '}') depth = Math.max(0, depth - 1);
          } else if (depth === 0 && tokens[j].kind === 'op' && tokens[j].raw === '=') {
            eqIdx = j;
            break;
          }
        }
        if (eqIdx !== -1) {
          let rhs = nextSig(eqIdx);
          while (rhs !== -1 && tokens[rhs].kind === 'punc' && tokens[rhs].raw === '(') rhs = nextSig(rhs);
          if (rhs !== -1 && tokens[rhs].kind === 'id' && tokens[rhs].raw === 'func') {
            for (let s = 0; s < segs.length - 1; s++) {
              cls[segs[s]] = tokens[segs[s]].kind === 'ty' ? 'tok-ty' : 'tok-ns';
            }
            cls[segs[segs.length - 1]] = 'tok-fn';
          }
        }
      }
      continue;
    }

    // Record field `name:` inside `{ ... }`
    if (braceStack.length > 0 && braceStack[braceStack.length - 1] === 'rec' && !cls[i]) {
      const n1 = nextSig(i);
      if (n1 !== -1 && tokens[n1].kind === 'punc' && tokens[n1].raw === ':') {
        cls[i] = 'tok-prop';
        continue;
      }
    }

    // Member access `.prop` / method call `.method(...)`
    if (i > 0 && tokens[i - 1].kind === 'punc' && tokens[i - 1].raw === '.' && !cls[i]) {
      const n1 = i + 1 < len ? tokens[i + 1] : null;
      cls[i] = n1 && n1.kind === 'punc' && n1.raw === '(' ? 'tok-fn' : 'tok-prop';
      continue;
    }

    // Module / namespace qualifier `math.vec3` or `math.Quat.rotate`
    if (!cls[i] && i + 2 < len && tokens[i + 1].kind === 'punc' && tokens[i + 1].raw === '.' && (tokens[i + 2].kind === 'ty' || tokens[i + 2].kind === 'id')) {
      const p = prevSig(i);
      if (p !== -1 && tokens[p].kind === 'id' && tokens[p].raw === 'as') {
        cls[i] = 'tok-ns';
      }
    }
  }

  // Pass 3: render HTML
  let out = '';
  for (let i = 0; i < len; i++) {
    const t = tokens[i];
    if (t.kind === 'str') {
      out += renderStringLiteral(t.raw);
    } else if (t.kind === 'bt') {
      out += renderBacktickInfix(t.raw);
    } else if (cls[i]) {
      out += `<span class="${cls[i]}">${escapeHtml(t.raw)}</span>`;
    } else {
      out += escapeHtml(t.raw);
    }
  }
  return out;
}
