import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools.js';
import { config } from './config.js';

// Fail closed: this server can read and write the whole vector index.
if (!config.mcpApiKey) {
  console.error('[http-server] MCP_API_KEY is not set — refusing to start.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
// index_document carries a whole document's extracted text.
app.use(express.json({ limit: '10mb' }));

// sessionId -> transport, one MCP session per connected client (site's
// chatbot.ts keeps one long-lived connection, so in practice this is small).
const transports = {};

const sha256 = (value) => createHash('sha256').update(String(value ?? '')).digest();

function requireApiKey(req, res, next) {
  if (!timingSafeEqual(sha256(req.headers['x-mcp-key']), sha256(config.mcpApiKey))) {
    return res.status(401).json({ error: 'Unauthorized — missing or invalid x-mcp-key header.' });
  }
  next();
}

app.post('/mcp', requireApiKey, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  let transport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };

    const server = new McpServer({ name: 'mcp', version: '0.1.0' });
    registerTools(server);
    await server.connect(transport);
  } else {
    return res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: missing or invalid session' },
      id: null,
    });
  }

  await transport.handleRequest(req, res, req.body);
});

// Session-bound GET (server->client streaming) and DELETE (session teardown).
app.get('/mcp', requireApiKey, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = sessionId && transports[sessionId];
  if (!transport) return res.status(400).send('Invalid or missing session');
  await transport.handleRequest(req, res);
});

app.delete('/mcp', requireApiKey, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = sessionId && transports[sessionId];
  if (transport) await transport.handleRequest(req, res);
  else res.status(400).send('Invalid or missing session');
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(config.port, () => {
  console.log(`mcp HTTP server listening on port ${config.port} (POST/GET/DELETE /mcp)`);
});
