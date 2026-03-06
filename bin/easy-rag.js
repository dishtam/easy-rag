#!/usr/bin/env node

import { program } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import readline from 'readline'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'),
)

async function getModules() {
  const [
    { loadConfig, saveConfig, DEFAULT_CONFIG },
    { scanFiles, getUnembeddedChunks },
    { embedChunks, embedTexts },
    { saveStore, loadStore, storeExists },
    { streamAnswer },
    { startServer },
    { HybridSearch },
  ] = await Promise.all([
    import('../src/config.js'),
    import('../src/indexer.js'),
    import('../src/embedder.js'),
    import('../src/vector-store.js'),
    import('../src/llm.js'),
    import('../src/server.js'),
    import('../src/hybrid-search.js'),
  ])
  return {
    loadConfig,
    saveConfig,
    DEFAULT_CONFIG,
    scanFiles,
    getUnembeddedChunks,
    embedChunks,
    embedTexts,
    saveStore,
    loadStore,
    storeExists,
    streamAnswer,
    startServer,
    HybridSearch,
  }
}

const banner = `${chalk.bold.magenta('⚡ easy-rag-cli')} ${chalk.gray(
  'v' + pkg.version,
)}`

// ── init ──────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Create easy-rag-cli.config.json in the current directory')
  .action(async () => {
    const { saveConfig, DEFAULT_CONFIG } = await getModules()
    const configPath = path.resolve(process.cwd(), 'easy-rag-cli.config.json')
    if (fs.existsSync(configPath)) {
      console.log(chalk.yellow('easy-rag-cli.config.json already exists.'))
      return
    }
    saveConfig(DEFAULT_CONFIG)
    console.log(banner)
    console.log(chalk.green('✔ Created easy-rag-cli.config.json'))
    console.log('\n  Edit it to set your provider, then run:')
    console.log(chalk.cyan('    npx easy-rag-cli index'))
  })

// ── index ─────────────────────────────────────────────────────────────────────
program
  .command('index')
  .description('Scan and index the codebase/documents')
  .option('--full', 'force full re-index (ignore incremental cache)')
  .action(async (opts) => {
    console.log(banner)
    const {
      loadConfig,
      scanFiles,
      getUnembeddedChunks,
      embedChunks,
      saveStore,
      HybridSearch,
    } = await getModules()
    const config = loadConfig()
    const incremental = !opts.full

    console.log(
      chalk.gray(
        `Provider: ${config.provider}  |  Mode: ${
          incremental ? 'incremental' : 'full'
        }  |  cwd: ${process.cwd()}`,
      ),
    )
    console.log('')

    // Scan
    const scanSpinner = ora('Scanning files…').start()
    const {
      chunks,
      fileCount,
      changedFiles,
      skippedFiles,
      fileHashes,
    } = await scanFiles(
      config,
      ({ file, chunkCount, reused }) => {
        scanSpinner.text = `Scanning… ${chalk.gray(file)} ${
          reused ? chalk.blue('[cached]') : ''
        } (${chunkCount} chunks)`
      },
      incremental,
    )

    const symbolCount = chunks.filter((c) => c.symbolName).length
    scanSpinner.succeed(
      `Found ${chalk.bold(fileCount)} files → ${chalk.bold(
        chunks.length,
      )} chunks, ${chalk.bold(symbolCount)} symbols` +
        (incremental
          ? chalk.gray(` (${changedFiles} changed, ${skippedFiles} cached)`)
          : ''),
    )

    if (chunks.length === 0) {
      console.log(
        chalk.yellow('No files found. Check your include/exclude patterns.'),
      )
      process.exit(1)
    }

    // Embed only new/changed chunks
    const toEmbed = getUnembeddedChunks(chunks)
    if (toEmbed.length > 0) {
      const embedSpinner = ora(`Embedding ${toEmbed.length} chunks…`).start()
      await embedChunks(toEmbed, config, ({ done, total }) => {
        embedSpinner.text = `Embedding ${done}/${total} chunks…`
      })
      embedSpinner.succeed(`Embedded ${chalk.bold(toEmbed.length)} chunks`)
    } else {
      console.log(chalk.gray('  ↳ All chunks already embedded (cached)'))
    }

    // Build hybrid index + save
    const saveSpinner = ora(
      'Building hybrid index (BM25 + symbol graph)…',
    ).start()
    const hybrid = new HybridSearch()
    hybrid.build(chunks)
    const storePath = saveStore(
      chunks,
      {
        fileCount,
        changedFiles,
        skippedFiles,
        provider: config.provider,
        fileHashes,
      },
      hybrid,
    )
    saveSpinner.succeed(
      `Saved to ${chalk.gray(path.relative(process.cwd(), storePath))}`,
    )

    console.log('')
    console.log(chalk.green.bold('✔ Indexing complete!'))
    console.log('')
    console.log(
      chalk.cyan('    npx easy-rag-cli ask "How does this project work?"'),
    )
    console.log(chalk.cyan('    npx easy-rag-cli serve'))
  })

// ── ask ───────────────────────────────────────────────────────────────────────
program
  .command('ask [question]')
  .description('Ask a question about your codebase')
  .option('-k, --top-k <number>', 'number of chunks to retrieve', '8')
  .option('-i, --interactive', 'start interactive Q&A session')
  .action(async (question, opts) => {
    console.log(banner)
    const {
      loadConfig,
      loadStore,
      embedTexts,
      streamAnswer,
      HybridSearch,
    } = await getModules()
    const config = loadConfig()
    const topK = parseInt(opts.topK) || 8

    let store
    try {
      store = loadStore()
    } catch (e) {
      console.error(chalk.red('✘ ' + e.message))
      process.exit(1)
    }

    // Build or load hybrid search
    const hybrid = new HybridSearch()
    if (store.hybridIndex) {
      hybrid.load(store.hybridIndex, store.chunks)
    } else {
      hybrid.build(store.chunks)
    }

    async function answerQuestion(q) {
      const spinner = ora('Searching (vector + BM25 + symbol graph)…').start()
      const [queryEmbedding] = await embedTexts([q], config)
      const results = hybrid.search(queryEmbedding, q, { topK })
      spinner.stop()

      // Show retrieved context info
      const byType = {}
      for (const r of results) {
        const t = r.symbolType || r.chunkType || 'chunk'
        byType[t] = (byType[t] || 0) + 1
      }
      console.log(
        chalk.gray(
          `\nRetrieved ${results.length} chunks: ${Object.entries(byType)
            .map(([k, v]) => `${v} ${k}`)
            .join(', ')}`,
        ),
      )

      const uniqueFiles = [...new Set(results.map((r) => r.filePath))]
      console.log(
        chalk.gray(
          `Sources: ${uniqueFiles.slice(0, 5).join(', ')}${
            uniqueFiles.length > 5 ? ` +${uniqueFiles.length - 5} more` : ''
          }\n`,
        ),
      )

      process.stdout.write(chalk.bold('Answer: '))
      for await (const delta of streamAnswer(q, results, config)) {
        process.stdout.write(delta)
      }
      console.log('\n')
    }

    if (opts.interactive || !question) {
      // Keep process alive while waiting for the next prompt
      process.stdin.resume()

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      })

      console.log(
        chalk.gray('Interactive mode — type exit or Ctrl+C to quit.\n'),
      )

      rl.on('close', () => {
        console.log(chalk.gray('\nGoodbye!'))
        process.exit(0)
      })
      process.on('SIGINT', () => rl.close())

      const promptNext = () => {
        setTimeout(() => {
          if (!rl.closed) rl.question(chalk.cyan('You: '), handleInput)
        }, 80)
      }

      const handleInput = async (input) => {
        input = input.trim()
        if (!input) {
          promptNext()
          return
        }
        if (['exit', 'quit', 'q'].includes(input.toLowerCase())) {
          rl.close()
          return
        }
        try {
          await answerQuestion(input)
        } catch (e) {
          console.error(chalk.red('\nError: ' + e.message))
        }
        promptNext()
      }

      rl.question(chalk.cyan('You: '), handleInput)
    } else {
      await answerQuestion(question)
      process.exit(0)
    }
  })

// ── serve ─────────────────────────────────────────────────────────────────────
program
  .command('serve')
  .description('Start the local web UI')
  .option('-p, --port <number>', 'port to listen on', '3141')
  .action(async (opts) => {
    console.log(banner)
    const { loadConfig, startServer, storeExists } = await getModules()
    const config = loadConfig()
    const port = parseInt(opts.port) || config.serve.port

    if (!storeExists()) {
      console.log(
        chalk.yellow('No index found. Run `npx easy-rag-cli index` first.'),
      )
      process.exit(1)
    }

    const app = await startServer(config)
    app.listen(port, () => {
      const url = `http://localhost:${port}`
      console.log(
        `\n  ${chalk.green('✔')} Web UI at ${chalk.cyan.underline(url)}\n`,
      )
    })
  })

// ── status ────────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show index status')
  .action(async () => {
    const { loadStore, storeExists } = await getModules()
    console.log(banner)
    if (!storeExists()) {
      console.log(
        chalk.yellow('\nNo index found. Run `npx easy-rag-cli index`.'),
      )
      return
    }

    const store = loadStore()
    const files = [...new Set(store.chunks.map((c) => c.filePath))]
    const symbols = store.chunks.filter((c) => c.symbolName)
    const byLang = {}
    for (const c of store.chunks) {
      byLang[c.language] = (byLang[c.language] || 0) + 1
    }

    console.log('')
    console.log(`  ${chalk.bold('Files:')}     ${files.length}`)
    console.log(`  ${chalk.bold('Chunks:')}    ${store.chunks.length}`)
    console.log(
      `  ${chalk.bold('Symbols:')}   ${
        symbols.length
      } (functions, classes, methods)`,
    )
    console.log(`  ${chalk.bold('Provider:')}  ${store.meta?.provider ?? '?'}`)
    console.log(
      `  ${chalk.bold('Mode:')}      ${
        store.meta?.changedFiles !== undefined
          ? `incremental (${store.meta.changedFiles} changed, ${store.meta.skippedFiles} cached)`
          : 'full'
      }`,
    )
    console.log(
      `  ${chalk.bold('Indexed:')}   ${new Date(
        store.createdAt,
      ).toLocaleString()}`,
    )
    console.log(
      `  ${chalk.bold('Languages:')} ${Object.entries(byLang)
        .map(([k, v]) => `${k}(${v})`)
        .join(' ')}`,
    )
    console.log('')
    files.slice(0, 15).forEach((f) => console.log(`  ${chalk.gray('·')} ${f}`))
    if (files.length > 15)
      console.log(`  ${chalk.gray(`... and ${files.length - 15} more`)}`)
  })

// ── config ────────────────────────────────────────────────────────────────────
program
  .command('config')
  .description('Interactively configure provider, models and API keys')
  .option('--show', 'print current config and exit')
  .option(
    '--set <key=value>',
    'set a single config value (e.g. --set provider=ollama)',
  )
  .action(async (opts) => {
    const { loadConfig, saveConfig } = await getModules()
    console.log(banner)
    console.log('')

    const config = loadConfig()

    // ── --show ───────────────────────────────────────────────────────────────
    if (opts.show) {
      console.log(chalk.bold('Current configuration:\n'))
      console.log(
        `  ${chalk.bold('Provider:')}         ${chalk.cyan(config.provider)}`,
      )
      console.log('')
      console.log(`  ${chalk.bold.yellow('OpenAI')}`)
      console.log(
        `    API Key:         ${
          config.openai.apiKey
            ? chalk.green('set (' + config.openai.apiKey.slice(0, 8) + '…)')
            : chalk.red('not set')
        }`,
      )
      console.log(`    Embedding model: ${config.openai.embeddingModel}`)
      console.log(`    Chat model:      ${config.openai.chatModel}`)
      console.log('')
      console.log(`  ${chalk.bold.blue('Ollama')}`)
      console.log(`    Base URL:        ${config.ollama.baseUrl}`)
      console.log(`    Embedding model: ${config.ollama.embeddingModel}`)
      console.log(`    Chat model:      ${config.ollama.chatModel}`)
      console.log('')
      return
    }

    // ── --set key=value (non-interactive) ────────────────────────────────────
    if (opts.set) {
      const [key, ...rest] = opts.set.split('=')
      const value = rest.join('=')
      if (!key || value === undefined) {
        console.error(
          chalk.red('Usage: --set key=value  e.g. --set provider=ollama'),
        )
        process.exit(1)
      }

      const setNested = (obj, path, val) => {
        const parts = path.split('.')
        let cur = obj
        for (let i = 0; i < parts.length - 1; i++) {
          if (!cur[parts[i]]) cur[parts[i]] = {}
          cur = cur[parts[i]]
        }
        cur[parts[parts.length - 1]] = val
      }

      // Aliases for convenience
      const aliases = {
        provider: 'provider',
        'openai.key': 'openai.apiKey',
        'openai.apikey': 'openai.apiKey',
        'openai.chat': 'openai.chatModel',
        'openai.embed': 'openai.embeddingModel',
        'ollama.url': 'ollama.baseUrl',
        'ollama.chat': 'ollama.chatModel',
        'ollama.embed': 'ollama.embeddingModel',
      }

      const resolved = aliases[key.toLowerCase()] || key
      setNested(config, resolved, value)
      saveConfig(config)
      console.log(
        chalk.green(`✔ Set ${chalk.bold(resolved)} = ${chalk.cyan(value)}`),
      )
      console.log(
        chalk.gray('  Run `npx easy-rag-cli config --show` to verify.'),
      )
      return
    }

    // ── Interactive wizard ───────────────────────────────────────────────────
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    const ask = (question, defaultVal) =>
      new Promise((resolve) => {
        const hint = defaultVal ? chalk.gray(` (${defaultVal})`) : ''
        rl.question(`  ${question}${hint}: `, (ans) => {
          resolve(ans.trim() || defaultVal || '')
        })
      })

    const choose = async (question, options, current) => {
      console.log(`\n  ${chalk.bold(question)}`)
      options.forEach((o, i) => {
        const active = o.value === current
        console.log(
          `    ${chalk.gray(i + 1 + '.')} ${
            active ? chalk.cyan.bold(o.label + ' ◀ current') : o.label
          }`,
        )
      })
      const answer = await ask(
        'Enter number',
        String(options.findIndex((o) => o.value === current) + 1),
      )
      const idx = parseInt(answer) - 1
      return options[idx]?.value ?? options[0].value
    }

    console.log(chalk.bold('🔧 easy-rag-cli configuration wizard\n'))

    // 1. Provider
    const provider = await choose(
      'Which LLM provider?',
      [
        { label: 'OpenAI  (cloud, fastest embeddings)', value: 'openai' },
        { label: 'Ollama  (local, fully private, free)', value: 'ollama' },
      ],
      config.provider,
    )

    config.provider = provider

    if (provider === 'openai') {
      console.log(`\n  ${chalk.yellow.bold('OpenAI settings')}`)

      const currentKey =
        config.openai.apiKey || process.env.OPENAI_API_KEY || ''
      const keyHint = currentKey
        ? `current: ${currentKey.slice(0, 8)}…`
        : 'sk-…'
      const apiKey = await ask('API key', keyHint)
      if (apiKey && !apiKey.startsWith('current:'))
        config.openai.apiKey = apiKey

      const chatModel = await choose(
        'Chat model',
        [
          {
            label: 'gpt-4o-mini   (fast, cheap — recommended)',
            value: 'gpt-4o-mini',
          },
          { label: 'gpt-4o        (best quality)', value: 'gpt-4o' },
          { label: 'gpt-3.5-turbo (legacy)', value: 'gpt-3.5-turbo' },
        ],
        config.openai.chatModel,
      )
      config.openai.chatModel = chatModel

      const embedModel = await choose(
        'Embedding model',
        [
          {
            label: 'text-embedding-3-small  (fast, cheap — recommended)',
            value: 'text-embedding-3-small',
          },
          {
            label: 'text-embedding-3-large  (higher quality, slower)',
            value: 'text-embedding-3-large',
          },
          {
            label: 'text-embedding-ada-002  (legacy)',
            value: 'text-embedding-ada-002',
          },
        ],
        config.openai.embeddingModel,
      )
      config.openai.embeddingModel = embedModel
    } else {
      console.log(`\n  ${chalk.blue.bold('Ollama settings')}`)

      const baseUrl = await ask('Ollama base URL', config.ollama.baseUrl)
      config.ollama.baseUrl = baseUrl

      // Try to auto-detect running models
      let availableModels = []
      try {
        const res = await fetch(`${baseUrl}/api/tags`)
        if (res.ok) {
          const data = await res.json()
          availableModels = (data.models || []).map((m) => m.name)
          if (availableModels.length > 0) {
            console.log(
              chalk.green(
                `\n  ✔ Connected to Ollama — found ${
                  availableModels.length
                } model(s): ${availableModels.join(', ')}`,
              ),
            )
          }
        }
      } catch {
        console.log(
          chalk.yellow(
            '\n  ⚠ Could not connect to Ollama at ' +
              baseUrl +
              '. Is it running?',
          ),
        )
        console.log(chalk.gray('    Start it with: ollama serve'))
      }

      // Build chat model choices
      const defaultChatModels = [
        { label: 'llama3         (recommended)', value: 'llama3' },
        { label: 'llama3.1       (latest llama)', value: 'llama3.1' },
        { label: 'mistral        (fast & capable)', value: 'mistral' },
        { label: 'codellama      (optimized for code)', value: 'codellama' },
        {
          label: 'deepseek-coder (strong code model)',
          value: 'deepseek-coder',
        },
        { label: 'phi3           (lightweight)', value: 'phi3' },
      ]

      const chatChoices =
        availableModels.length > 0
          ? availableModels.map((m) => ({
              label: `${m}  ${chalk.green('(installed)')}`,
              value: m,
            }))
          : defaultChatModels

      const chatModel = await choose(
        'Chat model',
        chatChoices,
        config.ollama.chatModel,
      )
      config.ollama.chatModel = chatModel

      const embedChoices =
        availableModels.length > 0
          ? availableModels.map((m) => ({
              label: `${m}  ${chalk.green('(installed)')}`,
              value: m,
            }))
          : [
              {
                label: 'nomic-embed-text  (recommended for RAG)',
                value: 'nomic-embed-text',
              },
              {
                label: 'mxbai-embed-large (higher quality)',
                value: 'mxbai-embed-large',
              },
              { label: 'all-minilm        (lightweight)', value: 'all-minilm' },
            ]

      const embedModel = await choose(
        'Embedding model',
        embedChoices,
        config.ollama.embeddingModel,
      )
      config.ollama.embeddingModel = embedModel

      // Remind about pulling models
      if (
        availableModels.length === 0 ||
        !availableModels.includes(chatModel)
      ) {
        console.log(
          chalk.gray(`\n  Remember to pull your models if not already done:`),
        )
        console.log(
          chalk.cyan(`    ollama pull ${config.ollama.embeddingModel}`),
        )
        console.log(chalk.cyan(`    ollama pull ${config.ollama.chatModel}`))
      }
    }

    rl.close()

    // Save
    saveConfig(config)
    console.log('')
    console.log(
      chalk.green.bold('✔ Configuration saved to easy-rag-cli.config.json'),
    )
    console.log('')
    console.log(`  Provider:  ${chalk.cyan.bold(config.provider)}`)
    if (provider === 'openai') {
      console.log(`  Chat:      ${chalk.cyan(config.openai.chatModel)}`)
      console.log(`  Embedding: ${chalk.cyan(config.openai.embeddingModel)}`)
    } else {
      console.log(`  URL:       ${chalk.cyan(config.ollama.baseUrl)}`)
      console.log(`  Chat:      ${chalk.cyan(config.ollama.chatModel)}`)
      console.log(`  Embedding: ${chalk.cyan(config.ollama.embeddingModel)}`)
    }
    console.log('')
    console.log('  Next step:')
    console.log(chalk.cyan('    npx easy-rag-cli index'))
  })

program
  .name('easy-rag-cli')
  .version(pkg.version)
  .description('Zero-config RAG for any codebase or document folder')
program.parse()
