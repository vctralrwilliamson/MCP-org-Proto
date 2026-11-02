import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from './config.js';

let clientPromise = null;

/** The tool ran and reported a failure (bad input, Qdrant/Ollama error). Not retried. */
export class ToolError extends Error {}

function connect() {
  const transport = new StreamableHTTPClientTransport(new URL(config.mcpServerUrl), {
    requestInit: {
      headers: config.mcpApiKey ? { 'x-mcp-key': config.mcpApiKey } : {},
    },
  });
  const client = new Client({ name: 'portal', version: '0.1.0' });
  return client.connect(transport).then(() => client);
}

function getClient() {
  if (!clientPromise) {
    clientPromise = connect().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

async function callOnce(name, args) {
  const client = await getClient();
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  if (result.isError) throw new ToolError(text || `${name} failed`);
  return text;
}

/**
 * Calls an mcp tool and returns its text output. If the long-lived session
 * died (mcp restarted, network blip) it reconnects and retries once.
 */
export async function callTool(name, args) {
  try {
    return await callOnce(name, args);
  } catch (err) {
    if (err instanceof ToolError) throw err;
    clientPromise = null;
    return callOnce(name, args);
  }
}
