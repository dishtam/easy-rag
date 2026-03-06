import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { chunkFile } from './chunker.js';
import { hashFile, loadFileHashes, loadExistingChunks } from './vector-store.js';

async function extractPdfText(filePath) {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  } catch { return null; }
}

export async function scanFiles(config, onProgress, incremental = false) {
  const cwd = process.cwd();
  const { include, exclude, chunkSize, chunkOverlap, maxFileSize } = config.index;

  const files = await glob(include, { cwd, ignore: exclude, nodir: true, absolute: true });

  const existingHashes = incremental ? loadFileHashes() : {};
  const existingChunksByFile = incremental ? loadExistingChunks() : {};

  const allChunks = [];
  const newFileHashes = {};
  let fileCount = 0, changedFiles = 0, skippedFiles = 0;

  for (const absPath of files) {
    try {
      const stat = fs.statSync(absPath);
      if (stat.size > maxFileSize) continue;

      const ext = path.extname(absPath).toLowerCase();
      const relativePath = path.relative(cwd, absPath);

      let text = '';
      if (ext === '.pdf') {
        text = await extractPdfText(absPath);
        if (!text) continue;
      } else {
        text = fs.readFileSync(absPath, 'utf-8');
      }
      if (!text.trim()) continue;

      const hash = hashFile(text);
      newFileHashes[relativePath] = hash;

      if (incremental && existingHashes[relativePath] === hash && existingChunksByFile[relativePath]) {
        allChunks.push(...existingChunksByFile[relativePath]);
        skippedFiles++;
        fileCount++;
        if (onProgress) onProgress({ file: relativePath, fileCount, chunkCount: allChunks.length, reused: true });
        continue;
      }

      const chunks = chunkFile(text, relativePath, { chunkSize, chunkOverlap });
      allChunks.push(...chunks);
      changedFiles++;
      fileCount++;
      if (onProgress) onProgress({ file: relativePath, fileCount, chunkCount: allChunks.length, reused: false });
    } catch { /* skip */ }
  }

  return { chunks: allChunks, fileCount, changedFiles, skippedFiles, fileHashes: newFileHashes };
}

export function getUnembeddedChunks(chunks) {
  return chunks.filter(c => !c.embedding);
}
