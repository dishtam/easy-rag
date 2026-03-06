import OpenAI from 'openai';

// ── OpenAI ────────────────────────────────────────────────────────────────────

function getOpenAIClient(config) {
  const apiKey = config.openai.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key not set. Add it to easy-rag-cli.config.json or set OPENAI_API_KEY env var.');
  return new OpenAI({ apiKey });
}

async function embedOpenAI(texts, config) {
  const client = getOpenAIClient(config);
  const BATCH = 100;
  const embeddings = [];

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const response = await client.embeddings.create({
      model: config.openai.embeddingModel,
      input: batch,
    });
    embeddings.push(...response.data.map(d => d.embedding));
  }

  return embeddings;
}

// ── Ollama ────────────────────────────────────────────────────────────────────

// Conservative char limits per embedding model (chars / 4 ≈ tokens)
const OLLAMA_CONTEXT_LIMITS = {
  'nomic-embed-text':   6000,  // 8192 token ctx
  'mxbai-embed-large':  1500,  // 512 token ctx — very small!
  'all-minilm':         1500,  // 512 token ctx
  'snowflake-arctic':   6000,
};
const DEFAULT_OLLAMA_CHAR_LIMIT = 4000; // safe fallback for unknown models

function truncateForOllama(text, model) {
  const limit = OLLAMA_CONTEXT_LIMITS[model] ?? DEFAULT_OLLAMA_CHAR_LIMIT;
  return text.length > limit ? text.slice(0, limit) : text;
}

async function embedOllama(texts, config) {
  const { baseUrl, embeddingModel } = config.ollama;
  const embeddings = [];

  for (const text of texts) {
    // Truncate to stay within the model's context window
    const safeText = truncateForOllama(text, embeddingModel);

    const res = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embeddingModel, prompt: safeText }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      // If still too long despite truncation, truncate harder and retry once
      if (res.status === 500 && errBody.includes('context length')) {
        const shorterText = text.slice(0, 1000);
        const retry = await fetch(`${baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: embeddingModel, prompt: shorterText }),
        });
        if (!retry.ok) throw new Error(`Ollama embedding failed after retry: ${retry.status}`);
        const retryData = await retry.json();
        embeddings.push(retryData.embedding);
        continue;
      }
      throw new Error(`Ollama embedding failed: ${res.status} ${errBody}`);
    }

    const data = await res.json();
    embeddings.push(data.embedding);
  }

  return embeddings;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function embedTexts(texts, config) {
  if (config.provider === 'ollama') {
    return embedOllama(texts, config);
  }
  return embedOpenAI(texts, config);
}

export async function embedChunks(chunks, config, onProgress) {
  const BATCH = config.provider === 'ollama' ? 10 : 100;
  let done = 0;

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const texts = batch.map(c => c.text);
    const embeddings = await embedTexts(texts, config);
    for (let j = 0; j < batch.length; j++) {
      batch[j].embedding = embeddings[j];
    }
    done += batch.length;
    if (onProgress) onProgress({ done, total: chunks.length });
  }
}
