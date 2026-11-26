import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  bibLint,
  citeAudit,
  layoutAudit,
  parseBibTeX,
  requiredFields,
  stripComments,
} from '../src/paper-checks.js';

const TEST_TMP = process.env.DSH_LATEX_TEST_TMP || os.tmpdir();

async function tempDir(t) {
  await mkdir(TEST_TMP, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_TMP, 'dsh-latex-paper-checks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stripComments removes comments and keeps line count', () => {
  const source = [
    'Alpha % hidden',
    '50\\% is literal',
    'backslash \\\\% is a comment',
    'final',
  ].join('\n');
  const stripped = stripComments(source);
  assert.equal(stripped.split('\n').length, source.split('\n').length);
  assert.equal(
    stripped,
    ['Alpha ', '50\\% is literal', 'backslash \\\\', 'final'].join('\n'),
  );
  assert.equal(stripComments('a % x\r\nb\r\n'), 'a \r\nb\r\n');
  assert.equal(stripComments(undefined), '');
  assert.equal(stripComments(42), '');
});

test('parseBibTeX parses common entry forms and skips non-entry blocks', () => {
  const bib = [
    '',
    '% bibliography header',
    '@article{smith2020,',
    '  author = {Smith, Jane and Doe, John},',
    '  title = {A {Nested} Title},',
    '  journal = "Journal of Tests",',
    '  year = 2020,',
    '  pages = {1--10},',
    '}',
    '@book(smithBook,',
    '  author = {Smith, Jane},',
    '  title = {A Book},',
    '  publisher = {Pub},',
    '  year = 2021,',
    ')',
    '@string{jot = "Journal of Tests"}',
    '@comment{@article{ignored, title={No}}}',
    '',
  ].join('\n');
  const parsed = parseBibTeX(bib);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.entries.length, 2);
  const [article, book] = parsed.entries;
  assert.equal(article.key, 'smith2020');
  assert.equal(article.type, 'article');
  assert.equal(article.fields.author, 'Smith, Jane and Doe, John');
  assert.equal(article.fields.title, 'A {Nested} Title');
  assert.equal(article.fields.journal, 'Journal of Tests');
  assert.equal(article.fields.year, '2020');
  assert.equal(article.fields.pages, '1--10');
  assert.equal(Number.isInteger(article.line), true);
  assert.equal(book.key, 'smithBook');
  assert.equal(book.type, 'book');
  assert.equal(book.fields.publisher, 'Pub');
});

test('parseBibTeX reports malformed entries without throwing', () => {
  const unterminated = parseBibTeX('@article{broken, title = {oops');
  assert.equal(unterminated.ok, false);
  assert.equal(unterminated.entries.length, 0);
  assert.equal(unterminated.errors[0].code, 'bib-unterminated-entry');
  assert.equal(unterminated.errors[0].line, 1);

  const missingValue = parseBibTeX('@article{x, title = {ok}, year = }');
  assert.equal(missingValue.ok, false);
  assert.equal(missingValue.entries.length, 1);
  assert.equal(missingValue.entries[0].fields.title, 'ok');
  assert.equal(missingValue.entries[0].fields.year, '');
  assert.ok(missingValue.errors.some((error) => error.code === 'bib-missing-value'));

  assert.equal(parseBibTeX(null).errors[0].code, 'bib-bad-input');
  assert.deepEqual(parseBibTeX(''), { ok: true, entries: [], errors: [] });
});

test('parseBibTeX accepts an entry without fields and keeps source lines', () => {
  assert.deepEqual(parseBibTeX('@misc{lonely}').entries, [
    { key: 'lonely', type: 'misc', fields: {}, line: 1 },
  ]);
  const two = parseBibTeX('@misc{a}\n\n@misc{b}');
  assert.deepEqual(two.entries.map((entry) => entry.line), [1, 3]);
});

test('requiredFields covers common types and reports canonical alternatives', () => {
  assert.deepEqual(requiredFields('article'), ['author', 'title', 'journal', 'year']);
  assert.deepEqual(requiredFields('book'), ['author', 'title', 'publisher', 'year']);
  assert.deepEqual(requiredFields('INBOOK'), [
    'author',
    'title',
    'chapter',
    'publisher',
    'year',
  ]);
  assert.deepEqual(requiredFields('misc'), []);
  assert.deepEqual(requiredFields('unknown-type'), []);
  assert.deepEqual(requiredFields(undefined), []);
});

test('bibLint flags duplicate keys and missing required fields', () => {
  const { issues } = bibLint([
    { key: 'dup', type: 'article', fields: { author: 'A', title: 'T' }, line: 1 },
    {
      key: 'dup',
      type: 'article',
      fields: { author: 'A', title: 'T', journal: 'J', year: '2020' },
      line: 5,
    },
    {
      key: 'book',
      type: 'book',
      fields: { editor: 'E', title: 'T', publisher: 'P', year: '2000' },
      line: 9,
    },
    {
      key: 'empty',
      type: 'article',
      fields: { author: ' ', title: 'T', journal: 'J', year: '2020' },
      line: 12,
    },
  ]);
  const duplicates = issues.filter((issue) => issue.code === 'duplicate-key');
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].key, 'dup');
  assert.equal(duplicates[0].line, 5);
  const missing = issues.filter((issue) => issue.code === 'missing-field');
  assert.ok(
    missing.some(
      (issue) => issue.key === 'dup' && issue.field === 'journal' && issue.line === 1,
    ),
  );
  assert.equal(
    missing.some((issue) => issue.key === 'book'),
    false,
    'an editor satisfies the author/editor requirement',
  );
  assert.ok(missing.some((issue) => issue.key === 'empty' && issue.field === 'author'));
});

test('bibLint reports unknown entry types and missing crossrefs', () => {
  const unknown = bibLint([{ key: 'x', type: 'podcast', fields: {} }]);
  assert.equal(unknown.issues[0].code, 'unknown-entry-type');
  assert.equal(unknown.issues[0].severity, 'warning');

  const broken = bibLint([
    {
      key: 'child',
      type: 'inbook',
      fields: { author: 'A', title: 'T', pages: '1--2', crossref: 'missing-parent' },
    },
  ]);
  assert.ok(
    broken.issues.some(
      (issue) => issue.code === 'missing-crossref' && issue.key === 'child',
    ),
  );
});

test('bibLint honors crossref inheritance for required fields', () => {
  const { issues } = bibLint([
    {
      key: 'book',
      type: 'book',
      fields: { editor: 'E', title: 'Collected', publisher: 'P', year: '2001' },
    },
    {
      key: 'chapter',
      type: 'inbook',
      fields: { author: 'A', title: 'Chapter', pages: '1--9', crossref: 'book' },
    },
  ]);
  assert.equal(
    issues.filter((issue) => issue.code === 'missing-field').length,
    0,
    JSON.stringify(issues),
  );
});

test('bibLint tolerates malformed entry lists', () => {
  assert.deepEqual(bibLint(null), { issues: [] });
  assert.deepEqual(bibLint('nope'), { issues: [] });
  assert.deepEqual(
    bibLint([null, 3, { type: 'misc' }]).issues.map((issue) => issue.code),
    ['invalid-entry', 'invalid-entry', 'missing-key'],
  );
  assert.deepEqual(bibLint(parseBibTeX('@misc{a}')), { issues: [] });
});

test('citeAudit recognizes citation commands, optional args and comments', () => {
  const tex = [
    '\\cite{alpha}',
    '\\citep[see][p.~2]{beta,gamma}',
    '\\textcite{delta} % \\cite{commented}',
    '\\autocite{epsilon}',
    '\\footcite{zeta}',
    '\\fullcite{eta}',
    '\\parencite{theta}',
    '\\citet*{iota}',
    '\\nocite{omega}',
  ].join('\n');
  const bibKeys = [
    'alpha',
    'beta',
    'gamma',
    'delta',
    'epsilon',
    'zeta',
    'eta',
    'theta',
    'iota',
    'omega',
    'unused',
  ];
  const bibText = bibKeys
    .map((key) => `@article{${key}, author={A}, title={T}, journal={J}, year={2020}}`)
    .join('\n');
  const audit = citeAudit({ texFiles: [{ path: 'paper.tex', text: tex }], bibText });
  assert.deepEqual(audit.cited, [
    'alpha',
    'beta',
    'delta',
    'epsilon',
    'eta',
    'gamma',
    'iota',
    'omega',
    'theta',
    'zeta',
  ]);
  assert.deepEqual(audit.missing, []);
  assert.deepEqual(audit.neverCited, ['unused']);
  assert.equal(audit.occurrences.length, 10);
  assert.deepEqual(audit.occurrences[1], {
    key: 'beta',
    path: 'paper.tex',
    line: 2,
    command: 'citep',
  });
  assert.equal(
    audit.occurrences.some((occurrence) => occurrence.key === 'commented'),
    false,
  );
  assert.equal(audit.nociteAll, false);
  assert.deepEqual(audit.bibErrors, []);
});

test('citeAudit distinguishes missing keys and handles \\nocite{*}', () => {
  const audit = citeAudit({
    texFiles: [{ path: 'main.tex', text: ['\\cite{known,missing}', '\\nocite{*}'].join('\n') }],
    bibText: '@misc{known}\n@misc{unused}',
  });
  assert.deepEqual(audit.cited, ['known', 'missing']);
  assert.deepEqual(audit.missing, ['missing']);
  assert.deepEqual(audit.neverCited, []);
  assert.equal(audit.nociteAll, true);
});

test('citeAudit does not throw on malformed input', () => {
  const empty = citeAudit();
  assert.deepEqual(empty.cited, []);
  assert.deepEqual(empty.missing, []);
  assert.deepEqual(empty.neverCited, []);
  assert.deepEqual(empty.occurrences, []);
  assert.doesNotThrow(() => citeAudit({ texFiles: 'nope', bibText: 42 }));
  const weird = citeAudit({
    texFiles: [null, 3, { path: 'x.tex', text: '\\cite{@odd}' }],
    bibText: '@ not a bib file',
  });
  assert.deepEqual(weird.cited, ['@odd']);
  assert.deepEqual(weird.missing, ['@odd']);
});

test('citeAudit works with files read from disk', async (t) => {
  const dir = await tempDir(t);
  const texPath = path.join(dir, 'main.tex');
  const bibPath = path.join(dir, 'references.bib');
  await writeFile(texPath, '\\citep[see]{paper}\n', 'utf8');
  await writeFile(
    bibPath,
    '@article{paper, author={A}, title={T}, journal={J}, year={2020}}\n',
    'utf8',
  );
  const audit = citeAudit({
    texFiles: [{ path: texPath, text: await readFile(texPath, 'utf8') }],
    bibText: await readFile(bibPath, 'utf8'),
  });
  assert.deepEqual(audit.cited, ['paper']);
  assert.deepEqual(audit.missing, []);
  assert.deepEqual(audit.neverCited, []);
});

test('layoutAudit reports overfull and underfull hboxes', () => {
  const logText = [
    'This is XeTeX',
    'Overfull \\hbox (12.34pt too wide) in paragraph at lines 10--12',
    'Underfull \\hbox (badness 10000) detected at line 20',
  ].join('\n');
  const { issues } = layoutAudit({ logText });
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['overfull-hbox', 'underfull-hbox'],
  );
  assert.equal(issues[0].line, 10);
  assert.equal(issues[0].endLine, 12);
  assert.equal(issues[0].amount, '12.34pt too wide');
  assert.equal(issues[0].severity, 'warning');
  assert.equal(issues[1].line, 20);
  assert.equal(issues[1].amount, 'badness 10000');
});

test('layoutAudit reports undefined references and citations', () => {
  const logText = [
    "LaTeX Warning: Reference `fig:one' on page 2 undefined on input line 12.",
    "LaTeX Warning: Citation `smith2020' on page 4 undefined on input line 15.",
    'LaTeX Warning: There were undefined references.',
  ].join('\n');
  const { issues } = layoutAudit({ logText });
  assert.equal(issues.length, 2);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['undefined-reference', 'undefined-citation'],
  );
  assert.equal(issues[0].key, 'fig:one');
  assert.equal(issues[0].page, 2);
  assert.equal(issues[0].line, 12);
  assert.equal(issues[1].key, 'smith2020');
  assert.equal(issues[1].page, 4);
  assert.equal(issues[1].line, 15);
});

test('layoutAudit merges diagnostics with log findings without duplicates', () => {
  const logText = "LaTeX Warning: Citation `dup' on page 1 undefined on input line 3.";
  const diagnostics = {
    errors: [],
    warnings: [
      {
        severity: 'warning',
        code: 'undefined-citation',
        message: "Citation `dup' on page 1 undefined on input line 3.",
        file: 'main.tex',
        line: 3,
      },
      {
        severity: 'warning',
        code: 'overfull',
        message: 'Overfull \\hbox (3.0pt too wide) in paragraph at lines 7--8',
        file: 'main.tex',
        line: 7,
        endLine: 8,
      },
    ],
    counts: { errors: 0, warnings: 2 },
  };
  const { issues } = layoutAudit({ logText, diagnostics });
  assert.equal(
    issues.filter((issue) => issue.code === 'undefined-citation').length,
    1,
  );
  assert.equal(issues.filter((issue) => issue.code === 'overfull-hbox').length, 1);
  const undefinedIssue = issues.find((issue) => issue.code === 'undefined-citation');
  assert.equal(undefinedIssue.file, 'main.tex');
  assert.equal(undefinedIssue.line, 3);
  const boxIssue = issues.find((issue) => issue.code === 'overfull-hbox');
  assert.equal(boxIssue.file, 'main.tex');
  assert.equal(boxIssue.line, 7);
  assert.equal(boxIssue.endLine, 8);
  assert.equal(boxIssue.severity, 'warning');
});

test('layoutAudit compares PDF page count with the TeX log', () => {
  const logText = 'Output written on main.pdf (12 pages, 345678 bytes).';
  const matched = layoutAudit({ logText, pages: 12 });
  assert.equal(matched.pageCount, 12);
  assert.equal(matched.logPages, 12);
  assert.deepEqual(matched.issues, []);

  const mismatched = layoutAudit({ logText, pages: 11 });
  assert.equal(mismatched.issues.length, 1);
  assert.equal(mismatched.issues[0].code, 'page-count-mismatch');
  assert.equal(mismatched.issues[0].pageCount, 11);
  assert.equal(mismatched.issues[0].logPages, 12);

  const pdfOnly = layoutAudit({ pages: 5 });
  assert.equal(pdfOnly.pageCount, 5);
  assert.deepEqual(pdfOnly.issues, []);

  const noOutput = layoutAudit({ logText: 'No pages of output.' });
  assert.equal(noOutput.logPages, 0);
  assert.equal(noOutput.pageCount, 0);
});

test('layoutAudit inventories figure and table labels and flags duplicates', () => {
  const auxText = [
    '\\relax',
    '\\newlabel{fig:first}{{1}{2}}',
    '\\newlabel{tab:one}{{1}{3}}',
    '\\newlabel{fig:first}{{1}{4}}',
    '\\newlabel{eq:main}{{1}{1}}',
    '\\newlabel{fig:second}{{2}{5}{Caption}{figure.2}{}}',
  ].join('\n');
  const { issues, figures, tables } = layoutAudit({ auxText });
  assert.deepEqual(
    figures.map((item) => item.key),
    ['fig:first', 'fig:first', 'fig:second'],
  );
  assert.deepEqual(
    tables.map((item) => item.key),
    ['tab:one'],
  );
  assert.equal(figures[0].number, '1');
  assert.equal(figures[0].page, '2');
  assert.equal(figures[0].line, 2);
  assert.equal(figures[2].line, 6);
  assert.equal(tables[0].page, '3');
  const duplicates = issues.filter((issue) => issue.code === 'duplicate-label');
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].key, 'fig:first');
  assert.equal(duplicates[0].count, 2);
  assert.equal(duplicates[0].line, 2);
});

test('layoutAudit applies custom regex rules and page limits', () => {
  const logText = [
    'Warning: big float on page 3',
    'Overfull \\hbox (1pt too wide) at line 9',
  ].join('\n');
  const auxText = '\\newlabel{fig:x}{{1}{1}}';
  const customRules = [
    {
      pattern: 'big float',
      code: 'big-float',
      message: 'Big float detected',
      severity: 'error',
      target: 'log',
    },
    { pattern: 'fig:', code: 'figure-label', target: 'aux' },
    { maxPages: 4 },
  ];
  const { issues } = layoutAudit({ logText, auxText, pages: 5, customRules });
  const big = issues.find((issue) => issue.code === 'big-float');
  assert.equal(big.severity, 'error');
  assert.equal(big.line, 1);
  assert.equal(big.source, 'log');
  assert.equal(big.message, 'Big float detected');
  const figure = issues.find((issue) => issue.code === 'figure-label');
  assert.equal(figure.source, 'aux');
  assert.equal(figure.line, 1);
  const pageLimit = issues.find((issue) => issue.code === 'page-count-exceeded');
  assert.equal(pageLimit.pageCount, 5);
  assert.equal(pageLimit.limit, 4);
});

test('layoutAudit turns invalid custom rules into issues', () => {
  const invalid = layoutAudit({ logText: 'plain', customRules: ['[unclosed'] });
  assert.equal(invalid.issues.length, 1);
  assert.equal(invalid.issues[0].code, 'invalid-custom-rule');
  assert.equal(invalid.issues[0].severity, 'error');

  const emptyRule = layoutAudit({ customRules: [null] });
  assert.equal(emptyRule.issues[0].code, 'invalid-custom-rule');
});

test('layoutAudit never throws on malformed input', () => {
  assert.deepEqual(layoutAudit().issues, []);
  assert.deepEqual(layoutAudit(null).issues, []);
  assert.deepEqual(
    layoutAudit({
      logText: 42,
      auxText: {},
      diagnostics: 'nope',
      customRules: 'nope',
      pages: 'many',
    }).issues,
    [],
  );
  const weird = layoutAudit({
    diagnostics: [{ message: null }, null, 'x'],
    customRules: [null, 42],
  });
  assert.equal(
    weird.issues.filter((issue) => issue.code === 'invalid-custom-rule').length,
    2,
  );
  assert.doesNotThrow(() => layoutAudit({ customRules: [{ pattern: '(?<bad' }] }));
});
