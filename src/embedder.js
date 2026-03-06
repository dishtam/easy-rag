import OpenAI from 'openai'

// ── OpenAI ────────────────────────────────────────────────────────────────────

function getOpenAIClient(config) {
  const apiKey = config.openai.apiKey || process.env.OPENAI_API_KEY
  if (!apiKey)
    throw new Error(
      'OpenAI API key not set. Add it to easy-rag-cli.config.json or set OPENAI_API_KEY env var.',
    )
  return new OpenAI({ apiKey })
}

async function embedOpenAI(texts, config) {
  const client = getOpenAIClient(config)
  const BATCH = 100 // OpenAI allows up to 2048 inputs but let's be safe
  const embeddings = []

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH)
    const response = await client.embeddings.create({
      model: config.openai.embeddingModel,
      input: batch,
    })
    embeddings.push(...response.data.map((d) => d.embedding))
  }

  return embeddings
}

// ── Ollama ────────────────────────────────────────────────────────────────────

async function embedOllama(texts, config) {
  const { baseUrl, embeddingModel } = config.ollama
  const embeddings = []

  // Ollama processes one at a time
  for (const text of texts) {
    const res = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embeddingModel, prompt: text }),
    })

    if (!res.ok) {
      throw new Error(
        `Ollama embedding failed: ${res.status} ${await res.text()}`,
      )
    }

    const data = await res.json()
    embeddings.push(data.embedding)
  }

  return embeddings
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed an array of strings using the configured provider.
 * Returns an array of number[] (one per input string).
 */
export async function embedTexts(texts, config) {
  if (config.provider === 'ollama') {
    return embedOllama(texts, config)
  }
  return embedOpenAI(texts, config)
}

/**
 * Embed chunks in batches, updating each chunk.embedding in-place.
 */
export async function embedChunks(chunks, config, onProgress) {
  const BATCH = config.provider === 'ollama' ? 10 : 100
  let done = 0

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH)
    const texts = batch.map((c) => c.text)
    const embeddings = await embedTexts(texts, config)
    for (let j = 0; j < batch.length; j++) {
      batch[j].embedding = embeddings[j]
    }
    done += batch.length
    if (onProgress) onProgress({ done, total: chunks.length })
  }
}
