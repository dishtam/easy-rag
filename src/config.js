import fs from 'fs';
import path from 'path';

const CONFIG_FILE = 'easy-rag-cli.config.json';
const STORE_FILE = '.easy-rag-cli-store.json';

export const DEFAULT_CONFIG = {
  provider: 'openai',          // 'openai' | 'ollama'
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
  },
  ollama: {
    baseUrl: 'http://localhost:11434',
    embeddingModel: 'nomic-embed-text',
    chatModel: 'llama3',
  },
  index: {
    include: [
      '**/*.js', '**/*.ts', '**/*.jsx', '**/*.tsx',
      '**/*.py', '**/*.go', '**/*.rs', '**/*.java',
      '**/*.c', '**/*.cpp', '**/*.h',
      '**/*.md', '**/*.txt', '**/*.pdf',
      '**/*.json', '**/*.yaml', '**/*.yml',
      '**/*.html', '**/*.css', '**/*.sh',
    ],
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.easy-rag-cli-store.json',
      '**/dist/**',
      '**/build/**',
      '**/*.lock',
      '**/*.log',
    ],
    chunkSize: 500,       // tokens per chunk
    chunkOverlap: 50,     // overlap tokens
    maxFileSize: 500000,  // bytes - skip files larger than this
  },
  serve: {
    port: 3141,
    openBrowser: true,
  },
};

export function loadConfig() {
  const configPath = path.resolve(process.cwd(), CONFIG_FILE);
  if (!fs.existsSync(configPath)) return DEFAULT_CONFIG;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const userConfig = JSON.parse(raw);
    return deepMerge(DEFAULT_CONFIG, userConfig);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config) {
  const configPath = path.resolve(process.cwd(), CONFIG_FILE);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

export function getStorePath() {
  return path.resolve(process.cwd(), STORE_FILE);
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      override[key] !== null &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}
