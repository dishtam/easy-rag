/**
 * Hybrid Search Engine
 *
 * Pipeline (mirrors what Copilot/Cursor do):
 *
 * 1. Vector search    → top-K by cosine similarity
 * 2. BM25 search      → top-K by keyword/identifier match
 * 3. RRF fusion       → Reciprocal Rank Fusion merges both lists
 * 4. Symbol graph     → expand with related files (1-hop import graph)
 * 5. Context assembly → fill context window, prioritizing higher-ranked chunks
 *
 * RRF formula: score(d) = Σ 1/(k + rank_i(d))
 * where k=60 is a standard constant that dampens high ranks.
 */

import { cosineSimilarity } from './vector-store.js';
import { BM25 } from './bm25.js';
import { SymbolGraph } from './symbol-graph.js';

const RRF_K = 60;

// ── RRF merge ─────────────────────────────────────────────────────────────────

function rrfMerge(rankedLists) {
  const scores = {};

  for (const list of rankedLists) {
    list.forEach((item, rank) => {
      const id = item.id;
      if (!scores[id]) scores[id] = { item, score: 0 };
      scores[id].score += 1 / (RRF_K + rank + 1);
    });
  }

  return Object.values(scores)
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({ ...item, rrfScore: score }));
}

// ── Context window filler ─────────────────────────────────────────────────────

const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CONTEXT_TOKENS = 6000; // safe limit to leave room for question + answer

/**
 * Fill a context window with chunks, respecting a token budget.
 * Deduplicates by file+symbol, prioritizes by RRF score.
 */
function fillContextWindow(rankedChunks, maxTokens = MAX_CONTEXT_TOKENS) {
  const seen = new Set();
  const selected = [];
  let budget = maxTokens;

  for (const chunk of rankedChunks) {
    const key = chunk.id;
    if (seen.has(key)) continue;

    const estimatedTokens = Math.ceil(chunk.text.length / APPROX_CHARS_PER_TOKEN);
    if (estimatedTokens > budget) continue;

    seen.add(key);
    selected.push(chunk);
    budget -= estimatedTokens;

    if (budget <= 0) break;
  }

  return selected;
}

// ── Main search class ─────────────────────────────────────────────────────────

export class HybridSearch {
  constructor() {
    this.bm25 = new BM25();
    this.graph = new SymbolGraph();
    this.chunks = [];
  }

  /**
   * Build all indexes from chunks.
   */
  build(chunks) {
    this.chunks = chunks;
    this.bm25.build(chunks);
    this.graph.build(chunks);
  }

  /**
   * Run hybrid search.
   *
   * @param {number[]} queryEmbedding
   * @param {string} queryText
   * @param {object} options
   * @returns {Array} final ranked, context-assembled chunks
   */
  search(queryEmbedding, queryText, options = {}) {
    const {
      topK = 8,
      useGraph = true,
      maxContextTokens = MAX_CONTEXT_TOKENS,
    } = options;

    const K = Math.max(topK * 3, 20); // retrieve more, then trim

    // 1. Vector search
    const vectorResults = this.chunks
      .filter(c => c.embedding && c.embedding.length > 0)
      .map(c => ({ ...c, vectorScore: cosineSimilarity(queryEmbedding, c.embedding) }))
      .sort((a, b) => b.vectorScore - a.vectorScore)
      .slice(0, K);

    // 2. BM25 keyword search
    const bm25Results = this.bm25.search(queryText, K);

    // 3. RRF fusion
    const fused = rrfMerge([vectorResults, bm25Results]);

    // 4. Symbol graph expansion
    let finalList = fused;

    if (useGraph) {
      const topFiles = fused.slice(0, topK).map(c => c.filePath);
      const referencedFiles = this.graph.findReferencedFiles(queryText);
      const expandedFiles = this.graph.expandContext([...topFiles, ...referencedFiles], 4);

      if (expandedFiles.length > 0) {
        // Find file-header chunks for expanded files (they give import/export context cheaply)
        const graphChunks = expandedFiles.flatMap(fp =>
          this.chunks.filter(c => c.filePath === fp && c.chunkType === 'file_header')
        );

        // Append graph chunks at the end (lower priority than RRF results)
        const fusedIds = new Set(fused.map(c => c.id));
        const newGraphChunks = graphChunks
          .filter(c => !fusedIds.has(c.id))
          .map(c => ({ ...c, rrfScore: 0.001, graphExpanded: true }));

        finalList = [...fused, ...newGraphChunks];
      }
    }

    // 5. Fill context window
    return fillContextWindow(finalList, maxContextTokens);
  }

  serialize() {
    return {
      bm25: this.bm25.serialize(),
      graph: this.graph.serialize(),
    };
  }

  load(data, chunks) {
    this.chunks = chunks;
    this.bm25.load(data.bm25, chunks);
    this.graph.load(data.graph);
  }
}
