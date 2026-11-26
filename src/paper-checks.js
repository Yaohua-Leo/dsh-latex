/**
 * Static paper checks for citations, bibliography entries and layout.
 *
 * The build pipeline already tells us whether TeX succeeded; these checks ask
 * the questions TeX only whispers about: is every cited key present in the
 * `.bib`, does each entry carry the fields its type requires, are figures or
 * tables defined twice, and which project-specific rules should the model see?
 *
 * Everything here is a pure function over text and returns findings as data.
 * Malformed input (a half-written `.bib`, a truncated log, an invalid custom
 * regex) never throws: the checks are most valuable exactly when the project
 * is broken, so a check tool that crashes on bad input helps nobody.
 */

const MAX_BIB_ENTRIES = 5000;
const MAX_BIB_ERRORS = 200;
const MAX_LAYOUT_ISSUES = 500;
const MAX_CUSTOM_MATCHES = 100;
const MAX_MESSAGE = 500;

/** Collapse every whitespace run, including newlines, to one space. */
function collapse(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Bounded, collapsed text for issue messages. */
function brief(value, max = MAX_MESSAGE) {
  const text = collapse(value);
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/** Offsets at which each 1-based line starts (index 0 is offset 0). */
function lineOffsets(text) {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) offsets.push(index + 1);
  }
  return offsets;
}

/** 1-based line number for a character offset. */
function lineAt(offsets, offset) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (offsets[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** Build an issue object without `undefined` members. */
function makeIssue(fields) {
  const issue = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) issue[name] = value;
  }
  return issue;
}

/**
 * Remove TeX comments while preserving the line structure of the document.
 *
 * A `%` starts a comment unless it is escaped by an odd number of preceding
 * backslashes: `\%` is a literal percent sign, while `\\%` is a line break
 * followed by a comment. Line breaks are copied through untouched, so line
 * numbers in the result still match the original file.
 *
 * Limitation: `%` inside a verbatim-like environment (`verbatim`, `lstlisting`,
 * `\verb`) is still treated as a comment, matching TeX's own behaviour outside
 * those environments closely enough for citation and structure audits.
 *
 * @param {string} text TeX source
 * @returns {string} source with comments removed
 */
export function stripComments(text) {
  if (typeof text !== 'string' || text === '') return '';
  const output = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      // Copy the backslash and whatever it escapes verbatim. Pairing them here
      // is what gives `%` its odd/even backslash parity.
      output.push(char);
      index += 1;
      if (index < text.length) {
        output.push(text[index]);
        index += 1;
      }
      continue;
    }
    if (char === '%') {
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1;
      continue;
    }
    output.push(char);
    index += 1;
  }
  return output.join('');
}

// ---------------------------------------------------------------------------
// BibTeX parsing
// ---------------------------------------------------------------------------

const BIB_ENTRY_HEAD_RE = /^@\s*([A-Za-z][A-Za-z0-9_-]*)\s*([{(])/;

function findBraceClose(text, start) {
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findQuoteClose(text, start) {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === '"') return index;
  }
  return -1;
}

/**
 * Find the delimiter that closes an entry body, starting just after the
 * opening `{` or `(`. Braces and quotes are skipped so a brace or paren inside
 * a value cannot end the entry early.
 */
function findEntryClose(text, start, open) {
  const close = open === '{' ? '}' : ')';
  let depth = 1;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (open === '(' && char === '"') {
      const quote = findQuoteClose(text, index + 1);
      index = quote < 0 ? text.length : quote + 1;
      continue;
    }
    if (open === '(' && char === '{') {
      const brace = findBraceClose(text, index + 1);
      index = brace < 0 ? text.length : brace + 1;
      continue;
    }
    if (open === '{' && char === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

/** Skip whitespace and `%` comment lines (only meaningful between fields). */
function skipBibSpace(text, index) {
  let cursor = index;
  for (;;) {
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    if (text[cursor] === '%') {
      while (cursor < text.length && text[cursor] !== '\n' && text[cursor] !== '\r') cursor += 1;
      continue;
    }
    return cursor;
  }
}

/** Index of the first comma that is not inside braces or quotes, or -1. */
function findTopLevelComma(text) {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (quoted) {
      if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (char === ',' && depth === 0) return index;
  }
  return -1;
}

/** Resume field parsing after a malformed fragment. */
function skipToNextFieldBoundary(text, index) {
  let depth = 0;
  let quoted = false;
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === '\\') {
      cursor += 1;
      continue;
    }
    if (quoted) {
      if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (char === ',' && depth === 0) return cursor + 1;
  }
  return text.length;
}

/**
 * Read one field value: a brace-delimited string, a quoted string, a bare
 * number or macro, or any `#`-concatenation of those.
 * @returns {{ value: string, end: number, error?: string }}
 */
function readBibValue(text, index) {
  const parts = [];
  let cursor = skipBibSpace(text, index);
  let error;
  for (;;) {
    if (cursor >= text.length || text[cursor] === ',') {
      error = 'empty';
      break;
    }
    const char = text[cursor];
    if (char === '{') {
      const close = findBraceClose(text, cursor + 1);
      if (close < 0) {
        parts.push(collapse(text.slice(cursor + 1)));
        error = 'unterminated-brace';
        cursor = text.length;
        break;
      }
      parts.push(collapse(text.slice(cursor + 1, close)));
      cursor = close + 1;
    } else if (char === '"') {
      const close = findQuoteClose(text, cursor + 1);
      if (close < 0) {
        parts.push(collapse(text.slice(cursor + 1)));
        error = 'unterminated-quote';
        cursor = text.length;
        break;
      }
      parts.push(collapse(text.slice(cursor + 1, close)));
      cursor = close + 1;
    } else {
      const bare = /^[^\s,#{}()"]+/.exec(text.slice(cursor));
      if (!bare) {
        error = 'bad-value';
        break;
      }
      parts.push(bare[0]);
      cursor += bare[0].length;
    }
    cursor = skipBibSpace(text, cursor);
    if (text[cursor] === '#') {
      cursor = skipBibSpace(text, cursor + 1);
      continue;
    }
    break;
  }
  return { value: parts.join(''), end: cursor, error };
}

/** Parse the comma-separated `name = value` list that follows an entry key. */
function parseBibFields(segment, offset, context) {
  const { fields, key, offsets, addError } = context;
  let index = 0;
  while (index < segment.length) {
    index = skipBibSpace(segment, index);
    if (index >= segment.length) break;
    if (segment[index] === ',') {
      index += 1;
      continue;
    }
    const fieldStart = index;
    const nameMatch = /^[A-Za-z][A-Za-z0-9_:.-]*/.exec(segment.slice(index));
    if (!nameMatch) {
      addError(
        'bib-bad-field',
        `Malformed field near "${brief(segment.slice(index, index + 40), 80)}"`,
        lineAt(offsets, offset + index),
        key,
      );
      index = skipToNextFieldBoundary(segment, index + 1);
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    index += nameMatch[0].length;
    index = skipBibSpace(segment, index);
    if (index >= segment.length || segment[index] !== '=') {
      addError(
        'bib-bad-field',
        `Field "${name}" is missing "="`,
        lineAt(offsets, offset + fieldStart),
        key,
      );
      index = skipToNextFieldBoundary(segment, index);
      continue;
    }
    index += 1;
    index = skipBibSpace(segment, index);
    const valueStart = index;
    const value = readBibValue(segment, index);
    index = value.end;
    if (value.error === 'empty') {
      addError(
        'bib-missing-value',
        `Field "${name}" has no value`,
        lineAt(offsets, offset + fieldStart),
        key,
      );
      fields[name] = '';
    } else if (value.error) {
      fields[name] = value.value;
      if (value.error === 'bad-value') {
        addError(
          'bib-bad-value',
          `Field "${name}" has an invalid value`,
          lineAt(offsets, offset + fieldStart),
          key,
        );
        index = skipToNextFieldBoundary(segment, valueStart + 1);
        continue;
      }
      addError(
        'bib-unterminated-value',
        `Field "${name}" has an unterminated ${
          value.error === 'unterminated-quote' ? 'quoted' : 'braced'
        } value`,
        lineAt(offsets, offset + fieldStart),
        key,
      );
    } else {
      fields[name] = value.value;
    }
    index = skipBibSpace(segment, index);
    if (index < segment.length && segment[index] !== ',') {
      addError(
        'bib-bad-field',
        `Unexpected text after field "${name}"`,
        lineAt(offsets, offset + index),
        key,
      );
      index = skipToNextFieldBoundary(segment, index + 1);
    }
  }
}

/** Parse one entry body (everything between the type's delimiters). */
function parseBibEntryBody(body, type, entryLine, bodyStart, offsets, addError) {
  if (body.trim() === '') {
    addError('bib-missing-key', `@${type} entry has no citation key`, entryLine);
    return undefined;
  }
  const comma = findTopLevelComma(body);
  const key = (comma < 0 ? body : body.slice(0, comma)).trim();
  if (key === '') {
    addError('bib-missing-key', `@${type} entry has no citation key`, entryLine);
    return undefined;
  }
  const fields = {};
  if (comma >= 0) {
    parseBibFields(body.slice(comma + 1), bodyStart + comma + 1, {
      fields,
      key,
      offsets,
      addError,
    });
  }
  return { key, type, fields, line: entryLine };
}

/**
 * Parse a BibTeX database into entries and recoverable errors.
 *
 * `@comment`, `@string` and `@preamble` blocks are skipped because they contain
 * no citable entry. Field names and entry types are lower-cased; values are
 * whitespace-collapsed, with the outer braces/quotes removed but nested braces
 * preserved. Parsing is forgiving: a malformed field is reported in `errors`
 * and the entry is still returned, so one broken entry does not hide the rest.
 *
 * @param {string} text `.bib` file contents
 * @returns {{ ok: boolean, entries: Array<{ key: string, type: string, fields: object, line: number }>, errors: Array<{ code: string, message: string, line?: number, key?: string }> }}
 */
export function parseBibTeX(text) {
  if (typeof text !== 'string') {
    return {
      ok: false,
      entries: [],
      errors: [
        { code: 'bib-bad-input', message: 'BibTeX input must be a string' },
      ],
    };
  }
  const offsets = lineOffsets(text);
  const entries = [];
  const errors = [];
  const addError = (code, message, line, key) => {
    if (errors.length >= MAX_BIB_ERRORS) return;
    errors.push(makeIssue({ code, message, line, key }));
  };
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf('@', index);
    if (at < 0) break;
    const head = BIB_ENTRY_HEAD_RE.exec(text.slice(at, at + 160));
    if (!head) {
      index = at + 1;
      continue;
    }
    const type = head[1].toLowerCase();
    const open = head[2];
    const bodyStart = at + head[0].length;
    const entryLine = lineAt(offsets, at);
    const close = findEntryClose(text, bodyStart, open);
    if (close < 0) {
      addError('bib-unterminated-entry', `Unterminated @${type} entry`, entryLine);
      break;
    }
    index = close + 1;
    if (type === 'comment' || type === 'string' || type === 'preamble') continue;
    if (entries.length >= MAX_BIB_ENTRIES) {
      addError(
        'bib-too-many-entries',
        `Only the first ${MAX_BIB_ENTRIES} BibTeX entries are parsed`,
        entryLine,
      );
      break;
    }
    const entry = parseBibEntryBody(
      text.slice(bodyStart, close),
      type,
      entryLine,
      bodyStart,
      offsets,
      addError,
    );
    if (entry) entries.push(entry);
  }
  return { ok: errors.length === 0, entries, errors };
}

// ---------------------------------------------------------------------------
// Required fields and lint
// ---------------------------------------------------------------------------

/**
 * Required fields per entry type. Each requirement is a group of acceptable
 * alternatives: `['author', 'editor']` means either satisfies it, and the first
 * name in the group is the canonical one reported by {@link requiredFields}.
 */
const ENTRY_REQUIREMENTS = Object.freeze({
  // BibTeX standard types.
  article: [['author'], ['title'], ['journal'], ['year']],
  book: [['author', 'editor'], ['title'], ['publisher'], ['year']],
  booklet: [['title']],
  inbook: [['author', 'editor'], ['title'], ['chapter', 'pages'], ['publisher'], ['year']],
  incollection: [['author'], ['title'], ['booktitle'], ['publisher'], ['year']],
  inproceedings: [['author'], ['title'], ['booktitle'], ['year']],
  conference: [['author'], ['title'], ['booktitle'], ['year']],
  manual: [['title']],
  mastersthesis: [['author'], ['title'], ['school'], ['year']],
  misc: [],
  phdthesis: [['author'], ['title'], ['school'], ['year']],
  proceedings: [['title'], ['year']],
  techreport: [['author'], ['title'], ['institution'], ['year']],
  unpublished: [['author'], ['title'], ['note']],
  // Common BibLaTeX types; `date` is accepted wherever `year` would be.
  online: [['author', 'editor'], ['title'], ['year', 'date'], ['url', 'doi', 'eprint']],
  electronic: [['author', 'editor'], ['title'], ['year', 'date'], ['url', 'doi', 'eprint']],
  www: [['author', 'editor'], ['title'], ['year', 'date'], ['url']],
  thesis: [['author'], ['title'], ['institution'], ['year', 'date']],
  report: [['author'], ['title'], ['institution'], ['year', 'date']],
  patent: [['author', 'editor'], ['title'], ['number'], ['year', 'date']],
  collection: [['editor'], ['title'], ['publisher'], ['year', 'date']],
  mvbook: [['author', 'editor'], ['title'], ['year', 'date']],
  mvcollection: [['editor'], ['title'], ['year', 'date']],
  mvproceedings: [['editor'], ['title'], ['year', 'date']],
  mvreference: [['editor'], ['title'], ['year', 'date']],
  reference: [['editor'], ['title'], ['year', 'date']],
  // Known types whose required fields depend on the bibliography style. They
  // parse and lint clean by default instead of producing false positives.
  dataset: [],
  software: [],
  audio: [],
  video: [],
  image: [],
  artwork: [],
  letter: [],
  performance: [],
  review: [],
  standard: [],
  legislation: [],
  jurisdiction: [],
  legal: [],
  periodical: [],
  suppbook: [],
  suppcollection: [],
  suppperiodical: [],
  inreference: [],
});

/**
 * Required fields for a BibTeX/BibLaTeX entry type.
 *
 * Alternative fields collapse to their canonical name: a `@book` needs an
 * author *or* an editor, so this reports `author`, while {@link bibLint}
 * accepts either. Unknown types return an empty array rather than guessing.
 *
 * @param {string} type entry type, case-insensitive
 * @returns {string[]} required field names
 */
export function requiredFields(type) {
  const key = typeof type === 'string' ? type.trim().toLowerCase() : '';
  const groups = ENTRY_REQUIREMENTS[key];
  if (!groups) return [];
  return groups.map((group) => group[0]);
}

function normalizeFields(fields) {
  const normalized = {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return normalized;
  for (const [name, value] of Object.entries(fields)) {
    if (typeof name !== 'string' || name === '') continue;
    normalized[name.toLowerCase()] = typeof value === 'string' ? value : value == null ? '' : String(value);
  }
  return normalized;
}

function hasFieldValue(fields, name) {
  if (!Object.prototype.hasOwnProperty.call(fields, name)) return false;
  const value = fields[name];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Bibliography keys named by `crossref`/`xdata` on an entry. */
function crossrefTargets(fields) {
  const targets = [];
  for (const name of ['crossref', 'xdata']) {
    const raw = fields[name];
    if (typeof raw !== 'string') continue;
    for (const part of raw.split(',')) {
      const target = part.trim();
      if (target !== '') targets.push(target);
    }
  }
  return targets;
}

/**
 * Merge fields inherited through `crossref`/`xdata`. Cycles are broken by the
 * `seen` set; a missing parent simply contributes nothing (and is reported by
 * the caller as `missing-crossref`).
 */
function inheritedFields(entry, byKey) {
  const merged = { ...entry.fields };
  const seen = new Set([entry.key]);
  const queue = crossrefTargets(entry.fields);
  while (queue.length > 0) {
    const target = queue.shift();
    if (seen.has(target)) continue;
    seen.add(target);
    const parent = byKey.get(target);
    if (!parent) continue;
    for (const [name, value] of Object.entries(parent.fields)) {
      if (!hasFieldValue(merged, name)) merged[name] = value;
    }
    for (const next of crossrefTargets(parent.fields)) queue.push(next);
  }
  return merged;
}

/**
 * Lint bibliography entries for duplicate keys and missing required fields.
 *
 * Accepts either an entry array or a {@link parseBibTeX} result. Fields
 * inherited through `crossref`/`xdata` satisfy requirements, so a
 * `@inbook` that only declares its own chapter and pages is not flagged for
 * the publisher and year supplied by its `@book` parent.
 *
 * Issue codes: `duplicate-key`, `missing-field`, `missing-key`, `missing-type`,
 * `unknown-entry-type`, `missing-crossref`, `invalid-entry`.
 *
 * @param {Array<{ key: string, type: string, fields: object }>|{ entries: Array<object> }} entries
 * @returns {{ issues: Array<{ code: string, severity: string, message: string, key?: string, type?: string, field?: string, line?: number, index?: number }> }}
 */
export function bibLint(entries) {
  const list = Array.isArray(entries)
    ? entries
    : Array.isArray(entries?.entries)
      ? entries.entries
      : [];
  const issues = [];
  const byKey = new Map();
  const prepared = [];
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    if (!entry || typeof entry !== 'object') {
      issues.push(
        makeIssue({
          code: 'invalid-entry',
          severity: 'error',
          message: 'BibTeX entry is not an object',
          index,
        }),
      );
      continue;
    }
    const key = typeof entry.key === 'string' ? entry.key.trim() : '';
    const type = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
    const line = Number.isFinite(entry.line) ? entry.line : undefined;
    if (key === '') {
      issues.push(
        makeIssue({
          code: 'missing-key',
          severity: 'error',
          message: 'BibTeX entry has no citation key',
          type: type || undefined,
          line,
          index,
        }),
      );
      continue;
    }
    if (type === '') {
      issues.push(
        makeIssue({
          code: 'missing-type',
          severity: 'error',
          message: `Entry "${key}" has no entry type`,
          key,
          line,
          index,
        }),
      );
    }
    const normalized = {
      key,
      type,
      fields: normalizeFields(entry.fields),
      line,
      index,
    };
    if (byKey.has(key)) {
      issues.push(
        makeIssue({
          code: 'duplicate-key',
          severity: 'error',
          message: `Duplicate citation key "${key}"`,
          key,
          type: type || undefined,
          line,
          index,
        }),
      );
    } else {
      byKey.set(key, normalized);
    }
    prepared.push(normalized);
  }

  for (const entry of prepared) {
    const { key, type, index, line } = entry;
    if (type !== '' && !ENTRY_REQUIREMENTS[type]) {
      issues.push(
        makeIssue({
          code: 'unknown-entry-type',
          severity: 'warning',
          message: `Unknown BibTeX entry type "@${type}" for key "${key}"; required fields were not checked`,
          key,
          type,
          line,
          index,
        }),
      );
    }
    const resolved = inheritedFields(entry, byKey);
    for (const target of crossrefTargets(entry.fields)) {
      if (!byKey.has(target)) {
        issues.push(
          makeIssue({
            code: 'missing-crossref',
            severity: 'warning',
            message: `Entry "${key}" references missing crossref "${target}"`,
            key,
            type: type || undefined,
            field: 'crossref',
            line,
            index,
          }),
        );
      }
    }
    const groups = ENTRY_REQUIREMENTS[type];
    if (!groups) continue;
    for (const group of groups) {
      if (group.some((name) => hasFieldValue(resolved, name))) continue;
      const alternatives = group.slice(1);
      const suffix =
        alternatives.length > 0
          ? ` (or ${alternatives.map((name) => `"${name}"`).join(', ')})`
          : '';
      issues.push(
        makeIssue({
          code: 'missing-field',
          severity: 'error',
          message: `@${type} "${key}" is missing required field "${group[0]}"${suffix}`,
          key,
          type,
          field: group[0],
          line,
          index,
        }),
      );
    }
  }
  return { issues };
}

// ---------------------------------------------------------------------------
// Citation audit
// ---------------------------------------------------------------------------

/** Commands that take a comma-separated list of citation keys. */
const CITE_COMMAND_RE =
  /(?<!\\)\\(fullcite|footcite|parencite|textcite|autocite|nocite|citep|citet|cite)\*?(?![A-Za-z])\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}/gi;

/**
 * Audit the citations of a paper against its bibliography.
 *
 * Comments are stripped first, so a commented-out `\cite` does not count.
 * Optional `[...]` arguments are ignored. `\nocite{*}` marks every bibliography
 * entry as cited, and `\nocite{key}` counts as a citation of `key`.
 *
 * @param {{ texFiles?: Array<{ path?: string, text?: string }>, bibText?: string }} [input]
 * @returns {{
 *   cited: string[],
 *   missing: string[],
 *   neverCited: string[],
 *   occurrences: Array<{ key: string, path: string, line: number, command: string }>,
 *   nociteAll: boolean,
 *   bibErrors: Array<object>,
 * }}
 */
export function citeAudit(input = {}) {
  const cited = new Set();
  const occurrences = [];
  let nociteAll = false;
  const texFiles = Array.isArray(input?.texFiles) ? input.texFiles : [];
  for (const file of texFiles) {
    if (!file || typeof file !== 'object') continue;
    const text = stripComments(typeof file.text === 'string' ? file.text : '');
    if (text === '') continue;
    const path = typeof file.path === 'string' ? file.path : '';
    const offsets = lineOffsets(text);
    for (const match of text.matchAll(CITE_COMMAND_RE)) {
      const command = (match[1] ?? '').toLowerCase();
      const line = lineAt(offsets, match.index ?? 0);
      for (const rawKey of (match[2] ?? '').split(',')) {
        const key = rawKey.trim();
        if (key === '') continue;
        if (command === 'nocite' && key === '*') {
          nociteAll = true;
          continue;
        }
        cited.add(key);
        occurrences.push({ key, path, line, command });
      }
    }
  }

  const bibText = typeof input?.bibText === 'string' ? input.bibText : '';
  const parsed = parseBibTeX(bibText);
  const bibKeys = new Set(parsed.entries.map((entry) => entry.key));
  const citedKeys = [...cited].sort();
  const missing = citedKeys.filter((key) => !bibKeys.has(key));
  const neverCited = nociteAll
    ? []
    : [...bibKeys].filter((key) => !cited.has(key)).sort();
  return {
    cited: citedKeys,
    missing,
    neverCited,
    occurrences,
    nociteAll,
    bibErrors: parsed.errors,
  };
}

// ---------------------------------------------------------------------------
// Layout audit
// ---------------------------------------------------------------------------

const UNDEFINED_WARNING_RE =
  /(?:Warning:\s*)?(Reference|Citation)\s+[`'"]([^`'"]+)[`'"]\s+(?:on page\s+(\d+)\s+)?undefined(?:\s+on input line\s+(\d+))?/i;
const MISSING_DATABASE_RE = /could not be found in the database:?\s*([^\s,]+)/i;
const BOX_WARNING_RE = /^(Overfull|Underfull)\s+\\([hv])box\b(.*)$/;
const OUTPUT_WRITTEN_RE = /\bOutput written on .*?\((\d+)\s+pages?\b/i;

/** Parse an "undefined reference/citation" warning body. */
function parseUndefinedWarning(text) {
  const match = UNDEFINED_WARNING_RE.exec(text);
  if (match) {
    return {
      code: match[1].toLowerCase() === 'reference' ? 'undefined-reference' : 'undefined-citation',
      key: match[2],
      page: match[3] ? Number(match[3]) : undefined,
      line: match[4] ? Number(match[4]) : undefined,
    };
  }
  if (/database/i.test(text)) {
    const missing = MISSING_DATABASE_RE.exec(text);
    if (missing) {
      return { code: 'undefined-citation', key: missing[1] };
    }
  }
  return undefined;
}

/** Parse one "Overfull/Underfull \hbox|\vbox" warning line. */
function parseBoxWarning(text) {
  const match = BOX_WARNING_RE.exec(text.trim());
  if (!match) return undefined;
  const kind = match[1].toLowerCase();
  const box = match[2].toLowerCase();
  const rest = match[3];
  const amount = /\(([^)]*)\)/.exec(rest)?.[1]?.trim();
  const range = /at lines?\s+(\d+)(?:--(\d+))?/.exec(rest);
  const detected = /detected at line\s+(\d+)/.exec(rest);
  const line = range ? Number(range[1]) : detected ? Number(detected[1]) : undefined;
  const endLine = range?.[2] ? Number(range[2]) : undefined;
  return { code: `${kind}-${box}box`, line, endLine, amount, message: brief(text) };
}

/** Render a custom rule message, supporting `$&`, `$1`-`$9` and `{match}`. */
function customRuleMessage(template, match) {
  if (typeof template !== 'string' || template.trim() === '') return undefined;
  return template.replace(/\$(&|\d)/g, (whole, token) => {
    if (token === '&') return match[0];
    return match[Number(token)] ?? '';
  });
}

/** Normalize one custom rule; returns `undefined` when it cannot be used. */
function normalizeCustomRule(raw) {
  if (raw instanceof RegExp) {
    return { pattern: raw.source, flags: raw.flags, target: 'all' };
  }
  if (typeof raw === 'string') {
    return raw === '' ? undefined : { pattern: raw, flags: '', target: 'all' };
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const pattern =
    raw.pattern instanceof RegExp
      ? raw.pattern.source
      : typeof raw.pattern === 'string' && raw.pattern !== ''
        ? raw.pattern
        : undefined;
  const maxPages = toPageLimit(raw.maxPages);
  const minPages = toPageLimit(raw.minPages);
  const hasPageRule = maxPages !== undefined || minPages !== undefined;
  if (!pattern && !hasPageRule) return undefined;
  const severity = ['error', 'warning', 'info'].includes(raw.severity) ? raw.severity : undefined;
  return {
    pattern,
    flags:
      raw.pattern instanceof RegExp
        ? raw.pattern.flags
        : typeof raw.flags === 'string'
          ? raw.flags
          : '',
    code: typeof raw.code === 'string' && raw.code.trim() !== '' ? raw.code.trim() : undefined,
    message: typeof raw.message === 'string' ? raw.message : undefined,
    severity,
    target: raw.target === 'log' || raw.target === 'aux' ? raw.target : 'all',
    maxPages,
    minPages,
  };
}

/** Accept a numeric page limit, ignoring null/empty/boolean placeholders. */
function toPageLimit(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Audit a compiled paper for layout problems.
 *
 * Inputs are all optional and every one of them is text or plain data, so the
 * function can run on a partial build:
 * - `logText`: TeX `.log` (or latexmk stdout) for box warnings, undefined
 *   references/citations and the reported page count;
 * - `auxText`: the `.aux` file for `\newlabel{fig:...}`/`tab:...` labels;
 * - `diagnostics`: an already-parsed `{errors, warnings}` set (or an array) from
 *   the build pipeline; recognised findings are merged without duplication;
 * - `pages`: the page count of the produced PDF, compared with the log;
 * - `customRules`: extra project rules. A string or `{ pattern, flags?, code?,
 *   message?, severity?, target? }` object is matched against the log and aux
 *   text; `target` narrows it to `'log'` or `'aux'`. An object with `maxPages`
 *   and/or `minPages` instead checks the document length.
 *
 * Issue codes: `overfull-hbox`, `underfull-hbox`, `overfull-vbox`,
 * `underfull-vbox`, `undefined-reference`, `undefined-citation`,
 * `page-count-mismatch`, `duplicate-label`, `page-count-exceeded`,
 * `page-count-below-min`, `custom-rule`, `invalid-custom-rule`.
 *
 * @param {{ auxText?: string, logText?: string, diagnostics?: object|Array<object>, pages?: number, customRules?: Array<string|RegExp|object> }} [input]
 * @returns {{ issues: Array<object>, pageCount?: number, logPages?: number, figures: Array<object>, tables: Array<object> }}
 */
export function layoutAudit(input = {}) {
  const issues = [];
  const seen = new Set();
  const add = (issue, dedupeKey) => {
    if (issues.length >= MAX_LAYOUT_ISSUES) return;
    const key = dedupeKey ?? `${issue.code}|${issue.line ?? ''}|${issue.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };

  const logText = typeof input?.logText === 'string' ? input.logText : '';
  const auxText = typeof input?.auxText === 'string' ? input.auxText : '';
  const logOffsets = lineOffsets(logText);
  const auxOffsets = lineOffsets(auxText);

  // Diagnostics arrive already parsed. Mine them first so the richer record
  // (with its file attribution) wins over a duplicate we would parse below.
  const diagnostics = Array.isArray(input?.diagnostics)
    ? input.diagnostics
    : Array.isArray(input?.diagnostics?.errors) || Array.isArray(input?.diagnostics?.warnings)
      ? [...(input.diagnostics.errors ?? []), ...(input.diagnostics.warnings ?? [])]
      : [];
  for (const diagnostic of diagnostics) {
    if (!diagnostic || typeof diagnostic !== 'object') continue;
    const message = typeof diagnostic.message === 'string' ? diagnostic.message : '';
    if (message === '') continue;
    const diagnosticLine = Number.isFinite(diagnostic.line) ? diagnostic.line : undefined;
    const file = typeof diagnostic.file === 'string' ? diagnostic.file : undefined;
    const undefinedWarning = parseUndefinedWarning(message);
    if (undefinedWarning) {
      add(
        makeIssue({
          ...undefinedWarning,
          severity: 'warning',
          message: `Undefined ${undefinedWarning.code === 'undefined-reference' ? 'reference' : 'citation'} "${
            undefinedWarning.key
          }"${undefinedWarning.page !== undefined ? ` on page ${undefinedWarning.page}` : ''}`,
          source: 'diagnostics',
          file,
          line: undefinedWarning.line ?? diagnosticLine,
          raw: brief(message),
        }),
        `${undefinedWarning.code}|${undefinedWarning.key}|${undefinedWarning.line ?? ''}`,
      );
      continue;
    }
    const boxWarning = parseBoxWarning(message);
    if (boxWarning) {
      add(
        makeIssue({
          ...boxWarning,
          severity: 'warning',
          source: 'diagnostics',
          file,
          line: boxWarning.line ?? diagnosticLine,
          endLine: boxWarning.endLine ?? (Number.isFinite(diagnostic.endLine) ? diagnostic.endLine : undefined),
          raw: brief(message),
        }),
        `${boxWarning.code}|${boxWarning.line ?? diagnosticLine ?? ''}|${boxWarning.message}`,
      );
      continue;
    }
    const code = typeof diagnostic.code === 'string' ? diagnostic.code.toLowerCase() : '';
    if (code === 'overfull' || code === 'underfull') {
      const box = /vbox/i.test(message) ? 'v' : 'h';
      add(
        makeIssue({
          code: `${code}-${box}box`,
          severity: 'warning',
          message: brief(message),
          source: 'diagnostics',
          file,
          line: diagnosticLine,
          raw: brief(message),
        }),
        `${code}-${box}box|${diagnosticLine ?? ''}|${brief(message)}`,
      );
    }
  }

  // TeX log: box warnings and undefined references/citations.
  const logLines = logText === '' ? [] : logText.split(/\r?\n/);
  for (let index = 0; index < logLines.length; index += 1) {
    const line = logLines[index];
    const undefinedWarning = parseUndefinedWarning(line);
    if (undefinedWarning) {
      add(
        makeIssue({
          ...undefinedWarning,
          severity: 'warning',
          message: `Undefined ${undefinedWarning.code === 'undefined-reference' ? 'reference' : 'citation'} "${
            undefinedWarning.key
          }"${undefinedWarning.page !== undefined ? ` on page ${undefinedWarning.page}` : ''}`,
          source: 'log',
          line: undefinedWarning.line,
          raw: brief(line),
        }),
        `${undefinedWarning.code}|${undefinedWarning.key}|${undefinedWarning.line ?? ''}`,
      );
      continue;
    }
    const boxWarning = parseBoxWarning(line);
    if (boxWarning) {
      add(
        makeIssue({
          ...boxWarning,
          severity: 'warning',
          source: 'log',
          raw: brief(line),
        }),
        `${boxWarning.code}|${boxWarning.line ?? index + 1}|${boxWarning.message}`,
      );
    }
  }

  // Page count: prefer the PDF count the caller measured, but remember what
  // the log claims so a stale PDF/skipped rerun is visible.
  let logPages;
  const written = OUTPUT_WRITTEN_RE.exec(logText);
  if (written) logPages = Number(written[1]);
  else if (/No pages of output/i.test(logText)) logPages = 0;
  const providedPages = toPageLimit(input?.pages);
  const pageCount =
    providedPages !== undefined && providedPages >= 0 ? Math.trunc(providedPages) : logPages;
  if (pageCount !== undefined && logPages !== undefined && pageCount !== logPages) {
    add(
      makeIssue({
        code: 'page-count-mismatch',
        severity: 'warning',
        message: `Page count mismatch: PDF reports ${pageCount} page(s), TeX log reports ${logPages}`,
        pageCount,
        logPages,
      }),
      `page-count-mismatch|${pageCount}|${logPages}`,
    );
  }

  // Figure/table labels from the .aux file.
  const figures = [];
  const tables = [];
  const labelCounts = new Map();
  for (const match of auxText.matchAll(/\\newlabel\{([^{}]+)\}/g)) {
    const key = match[1].trim();
    const type = key.startsWith('fig:') ? 'figure' : key.startsWith('tab:') ? 'table' : '';
    if (type === '') continue;
    const line = lineAt(auxOffsets, match.index ?? 0);
    const rest = auxText.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 400);
    const numbers = /^\{\{([^{}]*)\}\{([^{}]*)\}/.exec(rest);
    const item = { key, type, line };
    const number = numbers?.[1]?.trim();
    const page = numbers?.[2]?.trim();
    if (number) item.number = number;
    if (page) item.page = page;
    if (type === 'figure') figures.push(item);
    else tables.push(item);
    const previous = labelCounts.get(key);
    labelCounts.set(key, previous ? { count: previous.count + 1, line: previous.line } : { count: 1, line });
  }
  for (const [key, label] of labelCounts) {
    if (label.count <= 1) continue;
    add(
      makeIssue({
        code: 'duplicate-label',
        severity: 'warning',
        message: `Label "${key}" is defined ${label.count} times`,
        key,
        count: label.count,
        line: label.line,
      }),
      `duplicate-label|${key}`,
    );
  }

  // Custom rules. Configuration errors are reported as issues; they never
  // escape as exceptions from a malformed pattern.
  const customRules = Array.isArray(input?.customRules) ? input.customRules : [];
  const sources = [
    ['log', logText, logOffsets],
    ['aux', auxText, auxOffsets],
  ];
  for (let ruleIndex = 0; ruleIndex < customRules.length; ruleIndex += 1) {
    const rule = normalizeCustomRule(customRules[ruleIndex]);
    if (!rule) {
      add(
        makeIssue({
          code: 'invalid-custom-rule',
          severity: 'error',
          message: 'Custom rule must be a pattern string, RegExp, or an object with pattern/maxPages/minPages',
          source: 'config',
          ruleIndex,
        }),
        `invalid-custom-rule|${ruleIndex}`,
      );
      continue;
    }
    if (rule.maxPages !== undefined && pageCount !== undefined && pageCount > rule.maxPages) {
      add(
        makeIssue({
          code: rule.code ?? 'page-count-exceeded',
          severity: rule.severity ?? 'warning',
          message:
            rule.message ??
            `Document has ${pageCount} pages, above the limit of ${rule.maxPages}`,
          pageCount,
          limit: rule.maxPages,
          source: 'config',
          ruleIndex,
        }),
        `page-count-exceeded|${ruleIndex}|${pageCount}|${rule.maxPages}`,
      );
    }
    if (rule.minPages !== undefined && pageCount !== undefined && pageCount < rule.minPages) {
      add(
        makeIssue({
          code: rule.code ?? 'page-count-below-min',
          severity: rule.severity ?? 'warning',
          message:
            rule.message ??
            `Document has ${pageCount} pages, below the minimum of ${rule.minPages}`,
          pageCount,
          limit: rule.minPages,
          source: 'config',
          ruleIndex,
        }),
        `page-count-below-min|${ruleIndex}|${pageCount}|${rule.minPages}`,
      );
    }
    if (!rule.pattern) continue;
    let regex;
    try {
      const flags = new Set(rule.flags.replace(/[gy]/g, '').split(''));
      flags.add('g');
      regex = new RegExp(rule.pattern, [...flags].join(''));
    } catch (error) {
      add(
        makeIssue({
          code: 'invalid-custom-rule',
          severity: 'error',
          message: `Invalid custom rule pattern "${brief(rule.pattern, 120)}": ${
            error instanceof Error ? error.message : String(error)
          }`,
          source: 'config',
          ruleIndex,
        }),
        `invalid-custom-rule|${ruleIndex}`,
      );
      continue;
    }
    for (const [source, text, offsets] of sources) {
      if (rule.target !== 'all' && rule.target !== source) continue;
      let match;
      let count = 0;
      while ((match = regex.exec(text)) !== null) {
        if (match[0] === '') {
          regex.lastIndex += 1;
          if (regex.lastIndex > text.length) break;
          continue;
        }
        count += 1;
        const line = lineAt(offsets, match.index);
        add(
          makeIssue({
            code: rule.code ?? 'custom-rule',
            severity: rule.severity ?? 'warning',
            message:
              customRuleMessage(rule.message, match) ??
              `Custom rule matched: "${brief(match[0], 160)}"`,
            source,
            line,
            match: brief(match[0], 300),
            ruleIndex,
          }),
          `${rule.code ?? 'custom-rule'}|${ruleIndex}|${source}|${line}|${match[0]}`,
        );
        if (count >= MAX_CUSTOM_MATCHES) break;
      }
    }
  }

  return { issues, pageCount, logPages, figures, tables };
}
