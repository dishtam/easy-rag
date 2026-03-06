# ⚡ easy-rag-cli

**Zero-config RAG for any codebase or document folder.**

Install it, index your project, and start asking questions in plain English — via CLI, browser, or code.

---

## Install

```bash
npm install easy-rag-cli
# or globally
npm install -g easy-rag-cli
```

---

## Quick Start

```bash
# 1. Create a config file (optional — works with defaults too)
npx easy-rag-cli init

# 2. Set your API key
export OPENAI_API_KEY=sk-...

# 3. Index your project
npx easy-rag-cli index

# 4. Ask a question
npx easy-rag-cli ask "How does authentication work in this project?"

# 5. Or open the browser UI
npx easy-rag-cli serve
```

---

## Commands

| Command | Description |
|---|---|
| `easy-rag-cli init` | Create `easy-rag-cli.config.json` |
| `easy-rag-cli config` | Interactive provider/model setup wizard |
| `easy-rag-cli config --show` | Print current configuration |
| `easy-rag-cli config --set key=value` | Set a single config value |
| `easy-rag-cli index` | Scan & embed files into local vector store |
| `easy-rag-cli index --full` | Force full re-index (ignore cache) |
| `easy-rag-cli ask "question"` | Ask a question via CLI |
| `easy-rag-cli ask -i` | Interactive Q&A session |
| `easy-rag-cli serve` | Start web UI at `localhost:3141` |
| `easy-rag-cli serve --port 8080` | Start web UI on custom port |
| `easy-rag-cli status` | Show index stats |

---

## Programmatic API

```js
import { index, ask, askStream, searchChunks } from 'easy-rag-cli';

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

`easy-rag-cli.config.json`:

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

### Quick config via CLI

```bash
# Switch to Ollama
npx easy-rag-cli config --set provider=ollama

# Set OpenAI key
npx easy-rag-cli config --set openai.key=sk-abc123

# Set Ollama URL
npx easy-rag-cli config --set ollama.url=http://localhost:11434

# Set chat model
npx easy-rag-cli config --set ollama.chat=mistral

# View everything
npx easy-rag-cli config --show
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

By default, easy-rag-cli indexes:
- **Source code:** `.js`, `.ts`, `.jsx`, `.tsx`, `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`
- **Docs:** `.md`, `.txt`, `.pdf`
- **Config:** `.json`, `.yaml`, `.yml`, `.html`, `.css`, `.sh`

Files in `node_modules`, `.git`, `dist`, `build` are skipped automatically.

---

## How it works

1. **Scan** — globs your project for matching files
2. **Chunk** — splits code at function/class boundaries, docs at paragraph boundaries
3. **Embed** — generates vector embeddings via OpenAI or Ollama
4. **Index** — builds a hybrid BM25 + vector store with symbol graph locally (no external DB)
5. **Search** — fuses vector + keyword results via Reciprocal Rank Fusion, expands with import graph
6. **Answer** — passes top chunks as context to the LLM and streams the answer

---

## License

MIT
