/**
 * easy-rag-cli — Programmatic API
 *
 * @example
 * import { index, ask, askStream, searchChunks } from 'easy-rag-cli';
 *
 * await index();
 * const { answer, sources } = await ask('How does auth work?');
 *
 * for await (const delta of askStream('Explain the folder structure')) {
 *   process.stdout.write(delta);
 * }
 */

import { loadConfig } from './config.js'
import { scanFiles, getUnembeddedChunks } from './indexer.js'
import { embedChunks, embedTexts } from './embedder.js'
import { loadStore, saveStore } from './vector-store.js'
import { streamAnswer, getAnswer } from './llm.js'
import { HybridSearch } from './hybrid-search.js'

async function buildHybridAndSave(chunks, config, meta) {
  const hybrid = new HybridSearch()
  hybrid.build(chunks)
  saveStore(chunks, meta, hybrid)
  return hybrid
}

export async function index(options = {}) {
  const config = loadConfig()
  const { onProgress, incremental = false } = options

  const {
    chunks,
    fileCount,
    changedFiles,
    skippedFiles,
    fileHashes,
  } = await scanFiles(
    config,
    onProgress ? (p) => onProgress({ stage: 'scan', ...p }) : undefined,
    incremental,
  )

  // Only embed chunks that don't already have embeddings (incremental reuse)
  const toEmbed = getUnembeddedChunks(chunks)
  if (toEmbed.length > 0) {
    await embedChunks(
      toEmbed,
      config,
      onProgress ? (p) => onProgress({ stage: 'embed', ...p }) : undefined,
    )
  }

  const meta = {
    fileCount,
    changedFiles,
    skippedFiles,
    provider: config.provider,
    fileHashes,
  }
  await buildHybridAndSave(chunks, config, meta)

  return { fileCount, chunkCount: chunks.length, changedFiles, skippedFiles }
}

async function getHybridSearch(store, config) {
  const hybrid = new HybridSearch()
  if (store.hybridIndex) {
    hybrid.load(store.hybridIndex, store.chunks)
  } else {
    // Fallback: rebuild from chunks (v1 store)
    hybrid.build(store.chunks)
  }
  return hybrid
}

export async function ask(question, options = {}) {
  const config = loadConfig()
  const { topK = 8 } = options

  const store = loadStore()
  const [queryEmbedding] = await embedTexts([question], config)
  const hybrid = await getHybridSearch(store, config)
  const results = hybrid.search(queryEmbedding, question, { topK })

  const answer = await getAnswer(question, results, config)
  const sources = [...new Set(results.map((r) => r.filePath))]

  return { answer, sources }
}

export async function* askStream(question, options = {}) {
  const config = loadConfig()
  const { topK = 8 } = options

  const store = loadStore()
  const [queryEmbedding] = await embedTexts([question], config)
  const hybrid = await getHybridSearch(store, config)
  const results = hybrid.search(queryEmbedding, question, { topK })

  yield* streamAnswer(question, results, config)
}

export async function searchChunks(query, options = {}) {
  const config = loadConfig()
  const { topK = 8 } = options

  const store = loadStore()
  const [queryEmbedding] = await embedTexts([query], config)
  const hybrid = await getHybridSearch(store, config)

  return hybrid
    .search(queryEmbedding, query, { topK })
    .map(({ filePath, text, rrfScore, symbolName, symbolType }) => ({
      filePath,
      text,
      score: rrfScore,
      symbolName,
      symbolType,
    }))
}

export { loadConfig } from './config.js'
