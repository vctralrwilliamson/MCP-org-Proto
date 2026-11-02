import { config } from './config.js';
import { chunkText } from './chunk.js';
import { upsertChunk, deleteBySourceId } from './vectorstore.js';

async function fetchJson(path) {
  const url = new URL(path, config.webServer.url).toString();
  const res = await fetch(url, {
    headers: { 'x-api-key': config.webServer.apiKey, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`${url} -> ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res.json();
}

console.log('Fetching document list from the site...');
const { documents } = await fetchJson('/api/v1/documents');
console.log(`Found ${documents.length} document(s). Fetching full text and indexing...`);

let indexed = 0;
let skipped = 0;

for (const doc of documents) {
  try {
    const { text } = await fetchJson(`/api/v1/documents/${doc.id}/content`);
    if (!text || !text.trim()) {
      console.warn(`  - ${doc.originalName}: no extractable text, skipped`);
      skipped++;
      continue;
    }

    await deleteBySourceId(doc.id);
    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i++) {
      await upsertChunk({
        id: `${doc.id}-${i}`,
        text: chunks[i],
        title: doc.originalName,
        sourceId: doc.id,
        url: `/admin/api/documents/${doc.id}/download`,
        updatedAt: doc.uploadedAt,
      });
    }
    console.log(`  - ${doc.originalName}: indexed ${chunks.length} chunk(s)`);
    indexed++;
  } catch (err) {
    console.warn(`  - ${doc.originalName}: FAILED — ${err.message}`);
    skipped++;
  }
}

console.log(`Done. Indexed ${indexed} document(s), skipped ${skipped}.`);
