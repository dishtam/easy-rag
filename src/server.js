import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';
import { scanFiles, getUnembeddedChunks } from './indexer.js';
import { embedChunks, embedTexts } from './embedder.js';
import { loadStore, saveStore } from './vector-store.js';
import { streamAnswer } from './llm.js';
import { HybridSearch } from './hybrid-search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function getHybrid(store) {
  const hybrid = new HybridSearch();
  if (store.hybridIndex) {
    hybrid.load(store.hybridIndex, store.chunks);
  } else {
    hybrid.build(store.chunks);
  }
  return hybrid;
}

export async function startServer(config) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../ui')));

  app.get('/api/info', (req, res) => {
    try {
      const store = loadStore();
      const files = [...new Set(store.chunks.map(c => c.filePath))];
      const symbols = store.chunks.filter(c => c.symbolName).map(c => ({
        name: c.symbolName, type: c.symbolType, file: c.filePath, line: c.startLine,
      }));
      res.json({
        fileCount: store.meta?.fileCount ?? files.length,
        chunkCount: store.chunks.length,
        symbolCount: symbols.length,
        provider: store.meta?.provider ?? config.provider,
        createdAt: store.createdAt,
        changedFiles: store.meta?.changedFiles,
        skippedFiles: store.meta?.skippedFiles,
        files,
        symbols: symbols.slice(0, 200),
      });
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  app.post('/api/ask', async (req, res) => {
    const { question, topK = 8 } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    try {
      const store = loadStore();
      const [queryEmbedding] = await embedTexts([question], config);
      const hybrid = await getHybrid(store);
      const results = hybrid.search(queryEmbedding, question, { topK });

      const sources = results.map(r => ({
        file: r.filePath,
        symbol: r.symbolName || null,
        type: r.symbolType || null,
        line: r.startLine || null,
        score: r.rrfScore,
        graphExpanded: r.graphExpanded || false,
      }));
      send({ sources });

      for await (const delta of streamAnswer(question, results, config)) {
        send({ delta });
      }
      res.write('data: [DONE]\n\n');
    } catch (e) {
      send({ error: e.message });
    } finally {
      res.end();
    }
  });

  app.post('/api/reindex', async (req, res) => {
    try {
      const cfg = loadConfig();
      const incremental = req.body?.incremental !== false;
      const { chunks, fileCount, changedFiles, skippedFiles, fileHashes } =
        await scanFiles(cfg, null, incremental);

      const toEmbed = getUnembeddedChunks(chunks);
      if (toEmbed.length > 0) await embedChunks(toEmbed, cfg);

      const hybrid = new HybridSearch();
      hybrid.build(chunks);
      saveStore(chunks, { fileCount, changedFiles, skippedFiles, provider: cfg.provider, fileHashes }, hybrid);

      res.json({ success: true, fileCount, chunkCount: chunks.length, changedFiles, skippedFiles });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return app;
}
