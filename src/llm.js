import OpenAI from 'openai';

function buildSystemPrompt(chunks) {
  const context = chunks
    .map((c, i) => `[${i + 1}] File: ${c.filePath}\n${c.text}`)
    .join('\n\n---\n\n');

  return `You are a helpful assistant that answers questions about a codebase or document collection.
Use ONLY the context below to answer. If the answer isn't in the context, say so honestly.
Always mention which file(s) the information comes from.

CONTEXT:
${context}`;
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function* streamOpenAI(question, chunks, config) {
  const apiKey = config.openai.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key not set.');

  const client = new OpenAI({ apiKey });
  const stream = await client.chat.completions.create({
    model: config.openai.chatModel,
    messages: [
      { role: 'system', content: buildSystemPrompt(chunks) },
      { role: 'user', content: question },
    ],
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

// ── Ollama ────────────────────────────────────────────────────────────────────

async function* streamOllama(question, chunks, config) {
  const { baseUrl, chatModel } = config.ollama;
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: chatModel,
      stream: true,
      messages: [
        { role: 'system', content: buildSystemPrompt(chunks) },
        { role: 'user', content: question },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Ollama chat failed: ${res.status} ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.message?.content) yield obj.message.content;
      } catch {}
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Stream an answer given a question and retrieved chunks.
 * Yields string deltas as they arrive.
 */
export async function* streamAnswer(question, chunks, config) {
  if (config.provider === 'ollama') {
    yield* streamOllama(question, chunks, config);
  } else {
    yield* streamOpenAI(question, chunks, config);
  }
}

/**
 * Non-streaming version — collects all deltas into a string.
 */
export async function getAnswer(question, chunks, config) {
  let answer = '';
  for await (const delta of streamAnswer(question, chunks, config)) {
    answer += delta;
  }
  return answer;
}
