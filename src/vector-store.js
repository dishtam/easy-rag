/**
 * Vector store with:
 *  - cosine similarity search
 *  - incremental indexing (file hash tracking — only re-embed changed files)
 *  - HybridSearch index serialization
 */

import fs from 'fs'
import crypto from 'crypto'
import { getStorePath } from './config.js'

export function cosineSimilarity(a, b) {
  let dot = 0,
    normA = 0,
    normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function hashFile(text) {
  return crypto.createHash('sha1').update(text).digest('hex')
}

export function saveStore(chunks, meta = {}, hybridIndex = null) {
  const storePath = getStorePath()
  const store = {
    version: 2,
    createdAt: new Date().toISOString(),
    meta,
    chunks,
    hybridIndex: hybridIndex ? hybridIndex.serialize() : null,
    fileHashes: meta.fileHashes || {},
  }
  fs.writeFileSync(storePath, JSON.stringify(store))
  return storePath
}

export function loadStore() {
  const storePath = getStorePath()
  if (!fs.existsSync(storePath)) {
    throw new Error('No index found. Run `npx easy-rag-cli index` first.')
  }
  const raw = fs.readFileSync(storePath, 'utf-8')
  return JSON.parse(raw)
}

export function storeExists() {
  return fs.existsSync(getStorePath())
}

export function loadFileHashes() {
  if (!storeExists()) return {}
  try {
    const store = loadStore()
    return store.fileHashes || {}
  } catch {
    return {}
  }
}

export function loadExistingChunks() {
  if (!storeExists()) return {}
  try {
    const store = loadStore()
    const byFile = {}
    for (const chunk of store.chunks) {
      if (!byFile[chunk.filePath]) byFile[chunk.filePath] = []
      byFile[chunk.filePath].push(chunk)
    }
    return byFile
  } catch {
    return {}
  }
}

export function search(queryEmbedding, store, topK = 8) {
  return store.chunks
    .filter((c) => c.embedding && c.embedding.length > 0)
    .map((c) => ({
      ...c,
      score: cosineSimilarity(queryEmbedding, c.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
