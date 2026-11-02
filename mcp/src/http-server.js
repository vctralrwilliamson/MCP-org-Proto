import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools.js';
import { config } from './config.js';

const app = express();
app.use(express.json());

// sessionId -> transport, one MCP session per connected client (site's
// chatbot.ts keeps one long-lived connection, so in practice this is small).
const transports = {};

function requireApiKey(req, res, next) {
  if (!config.mcpApiKey) {
    console.warn('[http-server] WARNING: MCP_API_KEY is not set — this endpoint is open to anyone who can reach it.');
    return next();
  }
  if (req.headers['x-mcp-key'] !== config.mcpApiKey) {
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
