/**
 * Smart chunker.
 *
 * Code files  → one chunk per symbol (function / class / method)
 *               + one "file-level" chunk with imports, top-level statements
 *
 * Doc files   → semantic paragraph chunking (respects heading / paragraph breaks)
 *               instead of blind word-count splits
 */

import { parseFile, isCodeFile } from './parser.js';

// ── Code chunking ─────────────────────────────────────────────────────────────

function makeCodeChunks(text, filePath) {
  const { symbols, imports, exports, language } = parseFile(text, filePath);
  const chunks = [];

  // File-level chunk: imports + exports summary + first ~30 lines
  const fileLines = text.split('\n');
  const fileHeader = fileLines.slice(0, 40).join('\n').trim();

  chunks.push({
    id: `${filePath}#__file__`,
    filePath,
    chunkIndex: 0,
    chunkType: 'file_header',
    language,
    symbolName: null,
    symbolType: 'file',
    imports,
    exports,
    startLine: 1,
    text: [
      `FILE: ${filePath}`,
      `LANGUAGE: ${language}`,
      imports.length ? `IMPORTS: ${imports.slice(0, 20).join(', ')}` : '',
      exports.length ? `EXPORTS: ${exports.join(', ')}` : '',
      '',
      fileHeader,
    ].filter(Boolean).join('\n'),
    embedding: null,
  });

  // One chunk per symbol
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const text_ = [
      `FILE: ${filePath}  LINE: ${sym.startLine}  TYPE: ${sym.type}  NAME: ${sym.name}`,
      sym.doc ? `DOC: ${sym.doc}` : '',
      '',
      sym.body,
    ].filter(Boolean).join('\n');

    chunks.push({
      id: `${filePath}#${sym.name}@${sym.startLine}`,
      filePath,
      chunkIndex: i + 1,
      chunkType: 'symbol',
      language,
      symbolName: sym.name,
      symbolType: sym.type,
      signature: sym.signature,
      imports,
      exports,
      startLine: sym.startLine,
      text: text_,
      embedding: null,
    });
  }

  // Fallback: if no symbols were found, fall back to sliding-window
  if (symbols.length === 0) {
    return slidingWindowChunks(text, filePath, 400, 60, language);
  }

  return chunks;
}

// ── Doc chunking ──────────────────────────────────────────────────────────────

/**
 * Semantic paragraph chunker for markdown / plain text.
 * Splits at paragraph boundaries and heading lines, then merges
 * small paragraphs up to chunkSize words.
 */
function makeDocChunks(text, filePath, chunkSize = 400, overlap = 60) {
  // Split into semantic blocks at blank lines or headings
  const blocks = [];
  let current = [];

  for (const line of text.split('\n')) {
    const isHeading = /^#{1,6}\s/.test(line);
    const isBlank = line.trim() === '';

    if ((isHeading || isBlank) && current.length) {
      blocks.push(current.join('\n').trim());
      current = [];
    }
    if (!isBlank) current.push(line);
    if (isHeading) { blocks.push(line); current = []; }
  }
  if (current.length) blocks.push(current.join('\n').trim());

  const filtered = blocks.filter(b => b.trim().length > 10);

  // Merge small blocks into chunks of ~chunkSize words
  const chunks = [];
  let bucket = [];
  let wordCount = 0;
  let chunkIndex = 0;

  const flush = () => {
    const t = bucket.join('\n\n').trim();
    if (t) {
      chunks.push({
        id: `${filePath}#${chunkIndex}`,
        filePath,
        chunkIndex,
        chunkType: 'doc',
        language: 'doc',
        symbolName: null,
        symbolType: null,
        startLine: null,
        text: t,
        embedding: null,
      });
      chunkIndex++;
    }
    // Overlap: keep last block in bucket
    bucket = bucket.slice(-1);
    wordCount = bucket[0]?.split(/\s+/).length ?? 0;
  };

  for (const block of filtered) {
    const words = block.split(/\s+/).length;
    if (wordCount + words > chunkSize && bucket.length) flush();
    bucket.push(block);
    wordCount += words;
  }
  if (bucket.length) flush();

  return chunks;
}

// ── Sliding window fallback ───────────────────────────────────────────────────

function slidingWindowChunks(text, filePath, chunkSize = 400, overlap = 60, language = 'unknown') {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let i = 0, idx = 0;

  while (i < words.length) {
    const chunk = words.slice(i, i + chunkSize).join(' ');
    chunks.push({
      id: `${filePath}#${idx}`,
      filePath,
      chunkIndex: idx++,
      chunkType: 'sliding',
      language,
      symbolName: null,
      symbolType: null,
      startLine: null,
      text: chunk,
      embedding: null,
    });
    i += chunkSize - overlap;
    if (i >= words.length) break;
  }

  return chunks;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Chunk a single file intelligently.
 *
 * @param {string} text - file content
 * @param {string} filePath - relative path
 * @param {object} options
 * @returns {Array} chunks
 */
export function chunkFile(text, filePath, options = {}) {
  const { chunkSize = 400, chunkOverlap = 60 } = options;

  if (isCodeFile(filePath)) {
    return makeCodeChunks(text, filePath);
  }

  return makeDocChunks(text, filePath, chunkSize, chunkOverlap);
}
