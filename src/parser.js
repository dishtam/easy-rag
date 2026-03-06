/**
 * Language-aware symbol extractor.
 *
 * For each supported language, we extract:
 *  - functions / methods / arrow functions
 *  - classes / structs / interfaces
 *  - leading docstrings / comments
 *  - import/export relationships
 *
 * This replaces the naive word-count chunker for code files.
 * Documents (.md, .txt, .pdf) still use semantic paragraph chunking.
 */

// ── Language detection ────────────────────────────────────────────────────────

const LANG_MAP = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.sh': 'shell', '.bash': 'shell',
};

const DOC_EXTS = new Set(['.md', '.txt', '.pdf', '.rst', '.html', '.xml', '.csv']);

export function getLanguage(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (DOC_EXTS.has(ext)) return 'doc';
  return LANG_MAP[ext] || 'unknown';
}

export function isCodeFile(filePath) {
  return getLanguage(filePath) !== 'doc' && getLanguage(filePath) !== 'unknown';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLines(text) {
  return text.split('\n');
}

/**
 * Grab comment lines immediately before lineIndex (docstring / JSDoc / etc.)
 */
function extractLeadingDoc(lines, lineIndex, commentPatterns) {
  const docLines = [];
  let i = lineIndex - 1;

  // Skip blank lines
  while (i >= 0 && lines[i].trim() === '') i--;

  // Collect comment block going upward
  const isComment = (l) => commentPatterns.some(p => p.test(l.trim()));

  while (i >= 0 && isComment(lines[i])) {
    docLines.unshift(lines[i]);
    i--;
  }

  return docLines.join('\n').trim();
}

/**
 * Given a start line, grab the body until braces/indentation balance out.
 * Works for brace-delimited languages.
 */
function extractBraceBody(lines, startLine, maxLines = 150) {
  let depth = 0;
  let started = false;
  const bodyLines = [];

  for (let i = startLine; i < Math.min(lines.length, startLine + maxLines); i++) {
    const l = lines[i];
    bodyLines.push(l);

    for (const ch of l) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') depth--;
    }

    if (started && depth === 0) break;
  }

  return bodyLines.join('\n');
}

/**
 * Python: grab body by indentation level.
 */
function extractIndentBody(lines, startLine, baseIndent, maxLines = 150) {
  const bodyLines = [lines[startLine]];

  for (let i = startLine + 1; i < Math.min(lines.length, startLine + maxLines); i++) {
    const l = lines[i];
    const trimmed = l.trim();
    if (trimmed === '') { bodyLines.push(l); continue; }

    const indent = l.length - l.trimStart().length;
    if (indent <= baseIndent) break;
    bodyLines.push(l);
  }

  return bodyLines.join('\n');
}

// ── Per-language extractors ───────────────────────────────────────────────────

function extractJS(text, filePath) {
  const lines = getLines(text);
  const symbols = [];
  const imports = [];
  const exports = [];

  const commentPat = [/^\/\//, /^\/\*/, /^\*/, /^\*\//];

  // Import/export tracking
  for (const line of lines) {
    const imp = line.match(/^import\s+.+?\s+from\s+['"](.+?)['"]/);
    if (imp) imports.push(imp[1]);
    const req = line.match(/require\(['"](.+?)['"]\)/);
    if (req) imports.push(req[1]);
    const exp = line.match(/^export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)/);
    if (exp) exports.push(exp[1]);
  }

  // Patterns to detect symbol start lines
  const patterns = [
    // named function declaration
    { re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\(/, type: 'function' },
    // class
    { re: /^(?:export\s+)?(?:default\s+)?class\s+(\w+)/, type: 'class' },
    // const/let arrow function
    { re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(.*?\)\s*=>/, type: 'function' },
    // method inside class (2+ spaces indent)
    { re: /^  (?:async\s+)?(\w+)\s*\(.*?\)\s*\{/, type: 'method' },
  ];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    for (const { re, type } of patterns) {
      const m = lines[i].match(re) || trimmed.match(re);
      if (!m) continue;

      const name = m[1];
      const doc = extractLeadingDoc(lines, i, commentPat);
      const body = extractBraceBody(lines, i);

      symbols.push({
        name,
        type,
        filePath,
        startLine: i + 1,
        doc,
        body,
        signature: lines[i].trim(),
      });
      break;
    }
  }

  return { symbols, imports, exports };
}

function extractPython(text, filePath) {
  const lines = getLines(text);
  const symbols = [];
  const imports = [];
  const exports = [];

  const commentPat = [/^#/, /^"""/,  /^'''/];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    // Imports
    const imp = l.match(/^(?:from\s+(\S+)\s+)?import\s+(.+)/);
    if (imp) imports.push(imp[1] || imp[2].split(',')[0].trim());

    // def / async def
    const fn = l.match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\((.*)?\)(?:\s*->.*)?:/);
    if (fn) {
      const baseIndent = fn[1].length;
      const name = fn[2];
      const doc = extractLeadingDoc(lines, i, commentPat);
      const body = extractIndentBody(lines, i, baseIndent);

      // Check for docstring on next non-blank line
      let docstring = '';
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length && (lines[j].trim().startsWith('"""') || lines[j].trim().startsWith("'''"))) {
        const qs = lines[j].trim().startsWith('"""') ? '"""' : "'''";
        const dlines = [lines[j]];
        if (!lines[j].trim().slice(3).includes(qs) || lines[j].trim().length === 3) {
          j++;
          while (j < lines.length && !lines[j].includes(qs)) { dlines.push(lines[j]); j++; }
          if (j < lines.length) dlines.push(lines[j]);
        }
        docstring = dlines.join('\n').trim();
      }

      symbols.push({
        name,
        type: baseIndent > 0 ? 'method' : 'function',
        filePath,
        startLine: i + 1,
        doc: docstring || doc,
        body,
        signature: l.trim(),
      });
    }

    // class
    const cls = l.match(/^class\s+(\w+)/);
    if (cls) {
      const name = cls[1];
      exports.push(name);
      symbols.push({
        name,
        type: 'class',
        filePath,
        startLine: i + 1,
        doc: extractLeadingDoc(lines, i, commentPat),
        body: extractIndentBody(lines, i, 0),
        signature: l.trim(),
      });
    }
  }

  return { symbols, imports, exports };
}

function extractGo(text, filePath) {
  const lines = getLines(text);
  const symbols = [];
  const imports = [];
  const exports = [];
  const commentPat = [/^\/\//];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    // import block
    const imp = l.match(/^\s*"(.+?)"/);
    if (imp) imports.push(imp[1]);

    // func
    const fn = l.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/);
    if (fn) {
      const name = fn[1];
      const isExported = /^[A-Z]/.test(name);
      if (isExported) exports.push(name);

      symbols.push({
        name,
        type: 'function',
        filePath,
        startLine: i + 1,
        doc: extractLeadingDoc(lines, i, commentPat),
        body: extractBraceBody(lines, i),
        signature: l.trim(),
      });
    }

    // type/struct/interface
    const typ = l.match(/^type\s+(\w+)\s+(struct|interface)/);
    if (typ) {
      symbols.push({
        name: typ[1],
        type: typ[2],
        filePath,
        startLine: i + 1,
        doc: extractLeadingDoc(lines, i, commentPat),
        body: extractBraceBody(lines, i),
        signature: l.trim(),
      });
    }
  }

  return { symbols, imports, exports };
}

function extractRust(text, filePath) {
  const lines = getLines(text);
  const symbols = [];
  const imports = [];
  const exports = [];
  const commentPat = [/^\/\//, /^\/\/\//];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    const use = l.match(/^use\s+(.+?);/);
    if (use) imports.push(use[1]);

    const fn = l.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
    if (fn) {
      if (/^pub/.test(l.trim())) exports.push(fn[1]);
      symbols.push({
        name: fn[1],
        type: 'function',
        filePath,
        startLine: i + 1,
        doc: extractLeadingDoc(lines, i, commentPat),
        body: extractBraceBody(lines, i),
        signature: l.trim(),
      });
    }

    const st = l.match(/^(?:pub\s+)?struct\s+(\w+)/);
    if (st) {
      symbols.push({ name: st[1], type: 'struct', filePath, startLine: i + 1, doc: extractLeadingDoc(lines, i, commentPat), body: extractBraceBody(lines, i), signature: l.trim() });
    }

    const imp = l.match(/^impl\s+(?:\w+\s+for\s+)?(\w+)/);
    if (imp) {
      symbols.push({ name: `impl ${imp[1]}`, type: 'impl', filePath, startLine: i + 1, doc: extractLeadingDoc(lines, i, commentPat), body: extractBraceBody(lines, i), signature: l.trim() });
    }
  }

  return { symbols, imports, exports };
}

// Generic fallback for Java, C#, C/C++, etc.
function extractGenericBrace(text, filePath, lang) {
  const lines = getLines(text);
  const symbols = [];
  const imports = [];
  const exports = [];
  const commentPat = [/^\/\//, /^\/\*/, /^\*/];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    // import/using
    const imp = l.match(/^(?:import|using|#include)\s+["<]?(.+?)[">]?;?$/);
    if (imp) imports.push(imp[1]);

    // function/method detection: type name(...) {
    const fn = l.match(/^(?:(?:public|private|protected|static|async|virtual|override|inline)\s+)*\w[\w<>\[\]*&]+\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+\w+\s*)?\{?$/);
    if (fn && !/^(if|for|while|switch|catch)$/.test(fn[1])) {
      symbols.push({
        name: fn[1],
        type: 'function',
        filePath,
        startLine: i + 1,
        doc: extractLeadingDoc(lines, i, commentPat),
        body: extractBraceBody(lines, i),
        signature: l.trim(),
      });
    }

    // class/interface/enum
    const cls = l.match(/^(?:(?:public|abstract|final|sealed)\s+)*(?:class|interface|enum)\s+(\w+)/);
    if (cls) {
      symbols.push({
        name: cls[1],
        type: 'class',
        filePath,
        startLine: i + 1,
        doc: extractLeadingDoc(lines, i, commentPat),
        body: extractBraceBody(lines, i),
        signature: l.trim(),
      });
    }
  }

  return { symbols, imports, exports };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract symbols and import graph from a source file.
 * Returns { symbols, imports, exports, language }
 */
export function parseFile(text, filePath) {
  const lang = getLanguage(filePath);

  let result;
  switch (lang) {
    case 'javascript':
    case 'typescript':
      result = extractJS(text, filePath);
      break;
    case 'python':
      result = extractPython(text, filePath);
      break;
    case 'go':
      result = extractGo(text, filePath);
      break;
    case 'rust':
      result = extractRust(text, filePath);
      break;
    default:
      result = extractGenericBrace(text, filePath, lang);
  }

  return { ...result, language: lang };
}
