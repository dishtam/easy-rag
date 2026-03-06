/**
 * BM25 (Best Match 25) — keyword / identifier search.
 *
 * Why: Vector search is great for semantic meaning, but terrible for exact
 * symbol names. If you ask "what does validateToken do?", BM25 will instantly
 * find chunks containing the string "validateToken". Vectors might miss it.
 *
 * This is exactly what Copilot/Cursor use alongside embeddings.
 *
 * Parameters (empirically tuned for code search):
 *   k1 = 1.5  (term frequency saturation — higher for code since names repeat)
 *   b  = 0.3  (length normalization — lower for code since short functions are OK)
 */

const K1 = 1.5;
const B = 0.3;

// ── Tokenizer ─────────────────────────────────────────────────────────────────

/**
 * Code-aware tokenizer:
 * - splits camelCase and snake_case into sub-tokens
 * - lowercases
 * - removes very short tokens
 */
function tokenize(text) {
  if (!text) return [];

  // Split camelCase: getUserById → get user by id
  const camelSplit = text.replace(/([a-z])([A-Z])/g, '$1 $2');

  // Split on non-alphanumeric, also split snake_case
  const tokens = camelSplit
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1);

  return tokens;
}

// ── BM25 index ────────────────────────────────────────────────────────────────

export class BM25 {
  constructor() {
    this.docs = [];          // raw chunk refs
    this.tf = [];            // term frequency per doc: [{term: count}]
    this.df = {};            // document frequency per term
    this.avgDl = 0;          // average document length
    this.built = false;
  }

  /**
   * Build index from chunks array.
   */
  build(chunks) {
    this.docs = chunks;
    this.tf = [];
    this.df = {};

    let totalLen = 0;

    for (const chunk of chunks) {
      const tokens = tokenize(chunk.text);
      totalLen += tokens.length;

      const freq = {};
      for (const t of tokens) {
        freq[t] = (freq[t] || 0) + 1;
      }
      this.tf.push(freq);

      // Also index symbol name with extra weight (simulate field boosting)
      if (chunk.symbolName) {
        const nameTokens = tokenize(chunk.symbolName);
        for (const t of nameTokens) {
          freq[t] = (freq[t] || 0) + 5; // boost symbol name matches
        }
      }

      for (const t of Object.keys(freq)) {
        this.df[t] = (this.df[t] || 0) + 1;
      }
    }

    this.avgDl = totalLen / (chunks.length || 1);
    this.N = chunks.length;
    this.built = true;
  }

  /**
   * Score a single document against a query.
   */
  _score(docIdx, queryTokens) {
    const freq = this.tf[docIdx];
    const dl = Object.values(freq).reduce((a, b) => a + b, 0);
    let score = 0;

    for (const t of queryTokens) {
      const tf = freq[t] || 0;
      if (tf === 0) continue;

      const df = this.df[t] || 0;
      const idf = Math.log((this.N - df + 0.5) / (df + 0.5) + 1);
      const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (dl / this.avgDl)));

      score += idf * tfNorm;
    }

    return score;
  }

  /**
   * Search and return top-K results with scores.
   */
  search(query, topK = 10) {
    if (!this.built || this.docs.length === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scored = this.docs.map((doc, i) => ({
      ...doc,
      bm25Score: this._score(i, queryTokens),
    }));

    return scored
      .filter(d => d.bm25Score > 0)
      .sort((a, b) => b.bm25Score - a.bm25Score)
      .slice(0, topK);
  }

  /**
   * Serialize to plain object for JSON storage.
   */
  serialize() {
    return { tf: this.tf, df: this.df, avgDl: this.avgDl, N: this.N };
  }

  /**
   * Load from serialized object (don't rebuild from scratch).
   */
  load(data, chunks) {
    this.tf = data.tf;
    this.df = data.df;
    this.avgDl = data.avgDl;
    this.N = data.N;
    this.docs = chunks;
    this.built = true;
  }
}
