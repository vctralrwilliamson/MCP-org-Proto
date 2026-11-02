import { z } from 'zod';
import { chunkText } from './chunk.js';
import { upsertChunk, deleteBySourceId, search, listAll, dropCollection } from './vectorstore.js';
import { generateAnswer } from './embeddings.js';

// Optional on every tool: which instance collection to act on. Omitted means
// the server's default collection (what the production site always uses).
const collection = z
  .string()
  .optional()
  .describe('Instance collection to use (dev sandbox only). Omit for the default collection.');

/** Registers all tools onto a given McpServer instance. */
export function registerTools(server) {
  server.registerTool(
    'index_document',
    {
      title: 'Index a document',
      description:
        'Chunks, embeds, and upserts a document\'s already-extracted text into the vector index. ' +
        'Called by the site on every upload with the full text it already extracted (docx/xlsx/txt). ' +
        'Safe to call again for the same documentId — it overwrites that document\'s existing chunks.',
      inputSchema: {
        documentId: z.string(),
        title: z.string(),
        text: z.string(),
        sourceUrl: z.string().optional(),
        collection,
      },
    },
    async ({ documentId, title, text, sourceUrl, collection }) => {
      if (!text || !text.trim()) {
        return { content: [{ type: 'text', text: 'Skipped: no text extracted for this document.' }] };
      }
      await deleteBySourceId(documentId, collection);
      const chunks = chunkText(text);
      for (let i = 0; i < chunks.length; i++) {
        await upsertChunk({
          id: `${documentId}-${i}`,
          text: chunks[i],
          title,
          sourceId: documentId,
          url: sourceUrl ?? null,
          updatedAt: new Date().toISOString(),
          collection,
        });
      }
      return { content: [{ type: 'text', text: `Indexed ${chunks.length} chunk(s) for "${title}".` }] };
    }
  );

  server.registerTool(
    'remove_document',
    {
      title: 'Remove a document from the index',
      description: 'Deletes all indexed chunks for a documentId.',
      inputSchema: { documentId: z.string(), collection },
    },
    async ({ documentId, collection }) => {
      await deleteBySourceId(documentId, collection);
      return { content: [{ type: 'text', text: `Removed indexed chunks for document ${documentId}.` }] };
    }
  );

  server.registerTool(
    'ask',
    {
      title: 'Ask a question (RAG)',
      description:
        'Retrieves relevant chunks from the vector index and asks the local Ollama chat model to ' +
        'answer using only that context. Returns { answer, sources: [{ title, url, score }] }.',
      inputSchema: {
        question: z.string(),
        topK: z.number().int().min(1).max(20).optional(),
        collection,
      },
    },
    async ({ question, topK, collection }) => {
      const matches = await search(question, topK ?? 5, collection);
      if (matches.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                answer: "I don't have any indexed documents to answer from yet.",
                sources: [],
              }),
            },
          ],
        };
      }
      const answer = await generateAnswer(question, matches);
      const sources = matches.map((m) => ({ title: m.metadata.title, url: m.metadata.url, score: m.score }));
      return { content: [{ type: 'text', text: JSON.stringify({ answer, sources }) }] };
    }
  );

  server.registerTool(
    'search_docs',
    {
      title: 'Search indexed docs',
      description: 'Vector-search the index and return raw matching chunks (no LLM answer).',
      inputSchema: { query: z.string(), topK: z.number().int().min(1).max(20).optional(), collection },
    },
    async ({ query, topK, collection }) => {
      const matches = await search(query, topK ?? 5, collection);
      return { content: [{ type: 'text', text: JSON.stringify(matches, null, 2) }] };
    }
  );

  server.registerTool(
    'list_docs',
    {
      title: 'List indexed chunks',
      description: 'Returns metadata for every chunk currently stored in the index.',
      inputSchema: { collection },
    },
    async ({ collection }) => {
      const docs = await listAll(collection);
      return { content: [{ type: 'text', text: JSON.stringify(docs, null, 2) }] };
    }
  );

  server.registerTool(
    'drop_collection',
    {
      title: 'Drop an instance collection',
      description:
        'Deletes a dev-sandbox instance collection and everything in it. Only works on instance ' +
        'collections (INSTANCE_COLLECTION_PREFIX); the default collection can never be dropped.',
      inputSchema: { collection: z.string() },
    },
    async ({ collection }) => {
      await dropCollection(collection);
      return { content: [{ type: 'text', text: `Dropped collection ${collection}.` }] };
    }
  );
}
