/**
 * LaTeX log parser.
 *
 * The parser is deliberately conservative: it recognises the diagnostic
 * shapes latexmk produces with `-file-line-error`, the classic `! ...` /
 * `l.<n>` form, and the warning lines LaTeX, packages and classes emit. It
 * never invents a file or line: an unknown location stays `undefined` rather
 * than being attributed to the main file, so a model cannot be sent to the
 * wrong place.
 *
 * Input is the `.log` file when available, otherwise latexmk's stdout. The
 * `.log` is authoritative; stdout is only a fallback for projects that fail
 * before TeX opens it.
 */
import path from 'node:path';

const TEX_FILE_SUFFIXES = 'tex|sty|cls|ltx|def|cfg|clo|fd|bib|bbl|aux|dtx|ins';

const FILE_LINE_ERROR_RE = new RegExp(
  `^((?:[A-Za-z]:)?[^:\\n]*?\\.(?:${TEX_FILE_SUFFIXES})):(\\d+):\\s*(.*)$`,
);
const BANG_RE = /^!\s*(.*)$/;
const LINE_NUMBER_RE = /^l\.(\d+)\s*(.*)$/;
const WARNING_RE = /^(LaTeX|LaTeX Font|Package|Class|Module)\s+(?:(\S+)\s+)?Warning:\s*(.*)$/;
const ERROR_RE = /^((?:LaTeX|Package|Class|Module)\s+(?:\S+\s+)?Error):\s*(.*)$/;
const OVERFULL_RE = /^(Overfull|Underfull)\s+\\[hv]box\s*(?:\(([^)]*)\))?\s*(?:in paragraph|in alignment|detected)?\s*(?:at lines? (\d+)(?:--(\d+))?)?/;
const MISSING_CHAR_RE = /^Missing character: There is no (.+?) in font/;
const OUTPUT_RE = /Output written on (.+?) \((\d+) pages?,\s*(\d+) bytes?\)/;
const NO_OUTPUT_RE = /No pages of output/;
const FATAL_RE = /^!?\s*(Fatal error occurred|Emergency stop)/;

/** Normalize an absolute or project-relative path from the log. */
function resolveLogPath(raw, rootDir) {
  if (!raw) return undefined;
  let value = raw.trim().replace(/\s+$/, '');
  if (value === '') return undefined;
  value = value.replace(/^\((?:\.\/|\.\\)/, '').replace(/^\(/, '');
  if (path.isAbsolute(value)) return path.normalize(value);
  return path.resolve(rootDir, value);
}

function relativeToRoot(file, rootDir) {
  if (!file) return undefined;
  const relative = path.relative(rootDir, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.replace(/\\/g, '/');
}

function collapse(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyMessage(message) {
  const text = collapse(message);
  if (/^(LaTeX|LaTeX Font|Package|Class|Module)\s+(\S+\s+)?Warning:/i.test(text)) {
    return { severity: 'warning', message: text };
  }
  if (/^LaTeX Warning:/i.test(text)) return { severity: 'warning', message: text };
  return { severity: 'error', message: text };
}

function extractPackage(message) {
  const match = /^(?:Package|Class|Module)\s+(\S+)\s+(?:Error|Warning):\s*(.*)$/i.exec(message);
  if (!match) return { package: undefined, message };
  return { package: match[1], message: match[2] };
}

function extractInlineLine(message) {
  const patterns = [
    /on input line (\d+)/i,
    /detected at line (\d+)/i,
    /at line (\d+)/i,
    /^line (\d+):/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function extractLineRange(message) {
  const match = /at lines? (\d+)(?:--(\d+))?/i.exec(message);
  if (!match) return {};
  return { line: Number(match[1]), endLine: match[2] ? Number(match[2]) : undefined };
}

function extractMissingFile(message) {
  const match = /File\s+[`'"]([^`'"]+)[`'"]\s+not found/i.exec(message);
  return match ? match[1] : undefined;
}

function isContinuation(line) {
  if (line === '') return false;
  if (/^[!\\(]/.test(line)) return false;
  if (/^l\.\d+/.test(line)) return false;
  if (/^\s*$/.test(line)) return false;
  if (/^Here is how much of TeX/.test(line)) return false;
  if (/^No pages of output/.test(line)) return false;
  return /^\s+\S|^[a-z(]/.test(line);
}

/**
 * Parse one LaTeX log.
 *
 * @param {object} input
 * @param {string} [input.logText] authoritative `.log` contents
 * @param {string} [input.stdout] latexmk stdout used when no log exists
 * @param {string} input.rootDir project root (main file directory)
 * @param {string} [input.mainFile] absolute main file path
 * @param {number} [input.maxErrors]
 * @param {number} [input.maxWarnings]
 */
export function parseLatexLog({
  logText,
  stdout,
  rootDir,
  mainFile,
  maxErrors = 200,
  maxWarnings = 300,
}) {
  const fromLog = typeof logText === 'string' && logText.trim() !== '';
  const text = (fromLog ? logText : stdout) ?? '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const errors = [];
  const warnings = [];
  const seen = new Set();
  let pages;
  let outputFile;
  let fatal = false;

  const fileStack = [];
  let currentFile = mainFile;

  const pushDiagnostic = (diagnostic) => {
    const key = `${diagnostic.severity}|${diagnostic.file ?? ''}|${diagnostic.line ?? ''}|${collapse(
      diagnostic.message,
    )
      .slice(0, 240)
      .toLowerCase()}`;
    if (seen.has(key)) return;
    if (diagnostic.severity === 'error' && errors.length >= maxErrors) return;
    if (diagnostic.severity === 'warning' && warnings.length >= maxWarnings) return;
    seen.add(key);
    if (diagnostic.severity === 'error') errors.push(diagnostic);
    else warnings.push(diagnostic);
  };

  const makeDiagnostic = (fields) => {
    const rawFile = fields.file;
    const absolute = rawFile ? resolveLogPath(rawFile, rootDir) : undefined;
    const relFile = absolute ? relativeToRoot(absolute, rootDir) : fields.relFile;
    return {
      severity: fields.severity,
      code: fields.code,
      message: collapse(fields.message).slice(0, 2000),
      file: absolute ?? (fields.file === undefined ? undefined : fields.file),
      relFile,
      line: fields.line,
      endLine: fields.endLine,
      package: fields.package,
      hint: fields.hint,
      raw: typeof fields.raw === 'string' ? fields.raw.slice(0, 4000) : undefined,
    };
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    // Track the file TeX is currently reading: `(./sections/ch1.tex` pushes,
    // a closing `)` pops. This is approximate by design; a wrong guess only
    // means a diagnostic keeps its `undefined`/main-file location.
    if (/[(]/.test(line)) {
      const open = line.match(/\(([^()\s"'`]+?\.(?:tex|sty|cls|ltx|def|cfg|clo|fd|bib|bbl))/gi);
      if (open) {
        for (const token of open) {
          fileStack.push(token.slice(1));
        }
      }
    }
    if (line.includes(')')) {
      const closes = (line.match(/\)/g) ?? []).length;
      for (let count = 0; count < closes && fileStack.length > 0; count += 1) {
        fileStack.pop();
      }
    }
    const stacked = fileStack.length > 0 ? fileStack[fileStack.length - 1] : undefined;
    if (stacked) currentFile = resolveLogPath(stacked, rootDir);

    // file:line: message
    const fileLine = FILE_LINE_ERROR_RE.exec(line);
    if (fileLine) {
      let messageText = fileLine[3];
      // The file-line form may be wrapped in the parentheses TeX prints around
      // an opened file: `(/abs/more.tex:22: ...)`.
      if (line.startsWith('(') && messageText.endsWith(')')) {
        messageText = messageText.slice(0, -1);
      }
      const classified = classifyMessage(messageText);
      const parsedPackage = extractPackage(classified.message);
      pushDiagnostic(
        makeDiagnostic({
          severity: classified.severity,
          code: classified.severity === 'error' ? 'latex-error' : 'latex-warning',
          message: parsedPackage.message ?? classified.message,
          package: parsedPackage.package,
          file: fileLine[1],
          line: Number(fileLine[2]),
          raw: line,
        }),
      );
      continue;
    }

    // Classic `! ...` error with an `l.<n>` context a few lines later.
    const bang = BANG_RE.exec(line);
    if (bang) {
      const messageLines = [bang[1]];
      let lineNumber;
      const contextLines = [];
      let lookahead = index + 1;
      while (lookahead < lines.length && lookahead <= index + 30) {
        const next = lines[lookahead];
        const lineNumberMatch = LINE_NUMBER_RE.exec(next);
        if (lineNumberMatch) {
          lineNumber = Number(lineNumberMatch[1]);
          contextLines.push(next);
          break;
        }
        if (BANG_RE.test(next)) break;
        if (messageLines.length < 6 && isContinuation(next)) {
          messageLines.push(next.trim());
        } else if (next.trim() !== '') {
          contextLines.push(next);
          if (contextLines.length >= 6) break;
        }
        lookahead += 1;
      }
      const message = collapse(messageLines.join(' '));
      const parsedPackage = extractPackage(message);
      const file = currentFile ?? mainFile;
      const missingFile = extractMissingFile(message);
      const lineFromMessage = extractInlineLine(message);
      const code = missingFile
        ? 'missing-file'
        : /Emergency stop/i.test(message)
          ? 'emergency-stop'
          : /Undefined control sequence/i.test(message)
            ? 'undefined-control-sequence'
            : /Runaway argument/i.test(message)
              ? 'runaway-argument'
              : parsedPackage.package
                ? 'package-error'
                : 'latex-error';
      if (code === 'emergency-stop') fatal = true;
      pushDiagnostic(
        makeDiagnostic({
          severity: 'error',
          code,
          message: missingFile
            ? `File '${missingFile}' not found.`
            : parsedPackage.message,
          package: parsedPackage.package,
          hint: missingFile ? `Install the package providing '${missingFile}' in TeX Live.` : undefined,
          file,
          line: lineNumber ?? lineFromMessage,
          raw: [line, ...contextLines].join('\n'),
        }),
      );
      index = Math.max(index, lookahead - 1);
      continue;
    }

    // `Package xyz Error:` without a preceding `!`
    const errorLine = ERROR_RE.exec(line);
    if (errorLine && !/^!/.test(line)) {
      pushDiagnostic(
        makeDiagnostic({
          severity: 'error',
          code: 'latex-error',
          message: errorLine[2],
          package: /^Package/.test(errorLine[1]) ? errorLine[1].split(/\s+/)[1] : undefined,
          file: currentFile ?? mainFile,
          line: extractInlineLine(errorLine[2]),
          raw: line,
        }),
      );
      continue;
    }

    const warning = WARNING_RE.exec(line);
    if (warning) {
      const messageBody = warning[3];
      const continuation = [];
      let lookahead = index + 1;
      while (
        lookahead < lines.length &&
        continuation.length < 3 &&
        /^\s{2,}\S/.test(lines[lookahead]) &&
        !WARNING_RE.test(lines[lookahead].trim()) &&
        !BANG_RE.test(lines[lookahead])
      ) {
        continuation.push(lines[lookahead].trim());
        lookahead += 1;
      }
      const fullMessage = collapse([messageBody, ...continuation].join(' '));
      const range = extractLineRange(fullMessage);
      const isCitation = /Citation .* undefined/i.test(fullMessage);
      const isReference = /Reference .* undefined/i.test(fullMessage);
      pushDiagnostic(
        makeDiagnostic({
          severity: 'warning',
          code: isCitation
            ? 'undefined-citation'
            : isReference
              ? 'undefined-reference'
              : /Font shape|Font .* not available/i.test(fullMessage)
                ? 'font-warning'
                : 'latex-warning',
          message: fullMessage,
          package: warning[2],
          file: currentFile ?? mainFile,
          line: range.line ?? extractInlineLine(fullMessage),
          endLine: range.endLine,
          raw: [line, ...continuation].join('\n'),
        }),
      );
      continue;
    }

    const overfull = OVERFULL_RE.exec(line);
    if (overfull) {
      pushDiagnostic(
        makeDiagnostic({
          severity: 'warning',
          code: overfull[1].toLowerCase(),
          message: collapse(line),
          file: currentFile ?? mainFile,
          line: overfull[3] ? Number(overfull[3]) : undefined,
          endLine: overfull[4] ? Number(overfull[4]) : undefined,
          raw: line,
        }),
      );
      continue;
    }

    const missingChar = MISSING_CHAR_RE.exec(line);
    if (missingChar) {
      pushDiagnostic(
        makeDiagnostic({
          severity: 'warning',
          code: 'missing-character',
          message: collapse(line),
          file: currentFile ?? mainFile,
          raw: line,
        }),
      );
      continue;
    }

    const output = OUTPUT_RE.exec(line);
    if (output) {
      outputFile = output[1];
      pages = Number(output[2]);
      continue;
    }
    if (NO_OUTPUT_RE.test(line)) {
      pages = 0;
      continue;
    }
    if (FATAL_RE.test(line)) fatal = true;
  }

  return {
    errors,
    warnings,
    counts: {
      errors: errors.length,
      warnings: warnings.length,
      overfull: warnings.filter((item) => item.code === 'overfull' || item.code === 'underfull').length,
    },
    pages,
    outputFile,
    fatal,
    source: fromLog ? 'log' : 'stdout',
  };
}

/** Parse a BibTeX `.blg` or Biber `.blg` log for citation/database warnings. */
export function parseBibLog(text, rootDir) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { errors: [], warnings: [] };
  }
  const errors = [];
  const warnings = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^Warning--/.test(trimmed)) {
      warnings.push({ severity: 'warning', code: 'bibtex-warning', message: trimmed.slice(0, 1000) });
    } else if (/^WARN\b/i.test(trimmed)) {
      warnings.push({ severity: 'warning', code: 'biber-warning', message: trimmed.slice(0, 1000) });
    } else if (/^ERROR\b/i.test(trimmed)) {
      errors.push({ severity: 'error', code: 'biber-error', message: trimmed.slice(0, 1000) });
    } else if (/^I couldn't open database file/i.test(trimmed)) {
      errors.push({ severity: 'error', code: 'missing-bib', message: trimmed.slice(0, 1000) });
    } else if (/^I couldn't open style file/i.test(trimmed)) {
      errors.push({ severity: 'error', code: 'missing-bst', message: trimmed.slice(0, 1000) });
    } else if (/^error message/i.test(trimmed)) {
      errors.push({ severity: 'error', code: 'biber-error', message: trimmed.slice(0, 1000) });
    }
  }
  return { errors, warnings };
}

/**
 * A one-line human summary of a parsed diagnostic set.
 * @param {{counts?: {errors:number, warnings:number}, fatal?: boolean, pages?: number}} parsed
 */
export function summarize(parsed) {
  const errors = parsed.counts?.errors ?? 0;
  const warnings = parsed.counts?.warnings ?? 0;
  if (parsed.fatal) return `fatal LaTeX error (${errors} errors, ${warnings} warnings)`;
  if (errors > 0) return `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`;
  if (warnings > 0) return `compiled with ${warnings} warning${warnings === 1 ? '' : 's'}`;
  return 'clean build';
}
