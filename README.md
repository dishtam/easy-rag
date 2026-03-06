# ⚡ easy-rag

**Zero-config RAG for any codebase or document folder.**

Install it, index your project, and start asking questions in plain English — via CLI, browser, or code.

---

## Install

```bash
npm install easy-rag
# or globally
npm install -g easy-rag
```

---

## Quick Start

```bash
# 1. Create a config file (optional — works with defaults too)
npx easy-rag init

# 2. Set your API key
export OPENAI_API_KEY=sk-...

# 3. Index your project
npx easy-rag index

# 4. Ask a question
npx easy-rag ask "How does authentication work in this project?"

# 5. Or open the browser UI
npx easy-rag serve
```

---

## Commands

| Command | Description |
|---|---|
| `easy-rag init` | Create `easy-rag.config.json` |
| `easy-rag index` | Scan & embed files into local vector store |
| `easy-rag ask "question"` | Ask a question via CLI |
| `easy-rag ask -i` | Interactive Q&A session |
| `easy-rag serve` | Start web UI at `localhost:3141` |
| `easy-rag status` | Show index stats |

---

## Programmatic API

```js
import { index, ask, askStream, searchChunks } from 'easy-rag';

// Index the codebase
await index({
  onProgress: ({ stage, done, total }) => console.log(`${stage}: ${done}/${total}`)
});

// Ask a question (returns full answer)
const { answer, sources } = await ask('What does the main function do?');
console.log(answer);
console.log('Sources:', sources);

// Stream the answer
for await (const delta of askStream('Explain the folder structure')) {
  process.stdout.write(delta);
}

// Just search for relevant chunks
const chunks = await searchChunks('database connection', { topK: 3 });
chunks.forEach(c => console.log(c.filePath, c.score));
```

---

## Configuration

`easy-rag.config.json`:

```json
{
  "provider": "openai",
  "openai": {
    "apiKey": "sk-...",
    "embeddingModel": "text-embedding-3-small",
    "chatModel": "gpt-4o-mini"
  },
  "ollama": {
    "baseUrl": "http://localhost:11434",
    "embeddingModel": "nomic-embed-text",
    "chatModel": "llama3"
  },
  "index": {
    "include": ["**/*.js", "**/*.ts", "**/*.md", "**/*.pdf"],
    "exclude": ["**/node_modules/**", "**/.git/**"],
    "chunkSize": 500,
    "chunkOverlap": 50,
    "maxFileSize": 500000
  },
  "serve": {
    "port": 3141,
    "openBrowser": true
  }
}
```

### Using Ollama (local, free)

```json
{
  "provider": "ollama",
  "ollama": {
    "baseUrl": "http://localhost:11434",
    "embeddingModel": "nomic-embed-text",
    "chatModel": "llama3"
  }
}
```

Make sure Ollama is running and the models are pulled:
```bash
ollama pull nomic-embed-text
ollama pull llama3
```

---

## What gets indexed?

By default, easy-rag indexes:
- **Source code:** `.js`, `.ts`, `.jsx`, `.tsx`, `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`
- **Docs:** `.md`, `.txt`, `.pdf`
- **Config:** `.json`, `.yaml`, `.yml`, `.html`, `.css`, `.sh`

Files in `node_modules`, `.git`, `dist`, `build` are skipped automatically.

---

## How it works

1. **Scan** — globs your project for matching files
2. **Chunk** — splits each file into overlapping text chunks
3. **Embed** — generates vector embeddings via OpenAI or Ollama
4. **Store** — saves everything to `.easy-rag-store.json` locally (no external DB needed)
5. **Search** — at query time, embeds your question and finds the most similar chunks via cosine similarity
6. **Answer** — passes top chunks as context to the LLM and streams the answer

---

## License

MIT
