import 'dotenv/config';

function required(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`[config] Missing required env var: ${name} (check your .env)`);
  }
  return val;
}

export const config = {
  qdrant: {
    url: required('QDRANT_URL'),
    apiKey: process.env.QDRANT_API_KEY || undefined,
    collection: process.env.QDRANT_COLLECTION || 'advsearch_docs',
    vectorSize: Number(process.env.QDRANT_VECTOR_SIZE || 768),
    // When set (e.g. "inst_"), tools accept a `collection` argument so the dev
    // portal can keep each tester instance in its own collection. Only names
    // with this prefix are allowed. Leave unset in production to keep every
    // call on `collection` above.
    instancePrefix: process.env.INSTANCE_COLLECTION_PREFIX || undefined,
  },
  ollama: {
    url: process.env.OLLAMA_URL || 'http://localhost:11434',
    embedModel: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
    chatModel: process.env.OLLAMA_CHAT_MODEL || 'llama3.2',
  },
  // Only used by the optional one-time backfill script.
  webServer: {
    url: process.env.WEB_SERVER_URL,
    apiKey: process.env.WEB_SERVER_API_KEY,
  },
  // HTTP server settings — mcp runs standalone on its own machine now.
  port: Number(process.env.PORT || 3900),
  // Shared secret site must send as the x-mcp-key header on every request.
  mcpApiKey: process.env.MCP_API_KEY || undefined,
};
