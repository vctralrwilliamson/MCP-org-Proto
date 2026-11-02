import { QdrantClient } from '@qdrant/js-client-rest';
import { v5 as uuidv5 } from 'uuid';
import { config } from './config.js';
import { embed } from './embeddings.js';

const ID_NAMESPACE = '6f9c4c1e-6b6f-4e60-9a6a-0f7b5a2b7e3a';
const INSTANCE_NAME = /^[a-z0-9_]{1,64}$/;

let client = null;
const ensured = new Set();

function getClient() {
  if (!client) {
    client = new QdrantClient({ url: config.qdrant.url, apiKey: config.qdrant.apiKey });
  }
  return client;
}

/**
 * Maps an optional per-call collection name to the collection to use. No name
 * means the default collection; a name is only accepted when instance scoping
 * is enabled and it carries the configured prefix, so callers can never reach
 * an arbitrary collection on the same Qdrant.
 */
export function resolveCollection(name) {
  if (!name) return config.qdrant.collection;
  const prefix = config.qdrant.instancePrefix;
  if (!prefix) {
    throw new Error('Per-call collections are disabled on this server (INSTANCE_COLLECTION_PREFIX is not set).');
  }
  if (!name.startsWith(prefix) || !INSTANCE_NAME.test(name)) {
    throw new Error(`Invalid collection "${name}" — must start with "${prefix}" and use only a-z, 0-9 and _.`);
  }
  return name;
}

async function ensureCollection(name) {
  if (ensured.has(name)) return;
  const c = getClient();
  const { collections } = await c.getCollections();
  const exists = collections.some((col) => col.name === name);
  if (!exists) {
    await c.createCollection(name, {
      vectors: { size: config.qdrant.vectorSize, distance: 'Cosine' },
    });
  }
  ensured.add(name);
}

function toPointId(stringId) {
  return uuidv5(stringId, ID_NAMESPACE);
}

/**
 * Insert or update a document chunk. `id` should be stable (e.g. `${docId}-${chunkIndex}`)
 * so re-indexing the same document (re-upload, backfill re-run) overwrites rather
 * than duplicates.
 */
export async function upsertChunk({ id, text, title, sourceId, url, updatedAt, collection }) {
  const name = resolveCollection(collection);
  await ensureCollection(name);
  const c = getClient();
  const vector = await embed(text);

  await c.upsert(name, {
    wait: true,
    points: [
      {
        id: toPointId(id),
        vector,
        payload: { id, text, title, sourceId, url, updatedAt },
      },
    ],
  });
}

export async function deleteBySourceId(sourceId, collection) {
  const name = resolveCollection(collection);
  await ensureCollection(name);
  const c = getClient();
  await c.delete(name, {
    filter: { must: [{ key: 'sourceId', match: { value: sourceId } }] },
  });
}

export async function search(query, topK = 5, collection) {
  const name = resolveCollection(collection);
  await ensureCollection(name);
  const c = getClient();
  const vector = await embed(query);
  // client.search() was removed in @qdrant/js-client-rest 1.19; query() replaces it.
  const { points } = await c.query(name, {
    query: vector,
    limit: topK,
    with_payload: true,
  });
  return points.map((r) => ({ score: r.score, metadata: r.payload }));
}

export async function listAll(collection) {
  const name = resolveCollection(collection);
  await ensureCollection(name);
  const c = getClient();
  const out = [];
  let offset = undefined;
  do {
    const res = await c.scroll(name, {
      limit: 100,
      offset,
      with_payload: true,
      with_vector: false,
    });
    out.push(...res.points.map((p) => p.payload));
    offset = res.next_page_offset ?? undefined;
  } while (offset);
  return out;
}

/** Deletes an instance collection outright. The default collection can't be dropped. */
export async function dropCollection(collection) {
  if (!collection) throw new Error('A collection name is required.');
  const name = resolveCollection(collection);
  const c = getClient();
  const { collections } = await c.getCollections();
  if (collections.some((col) => col.name === name)) {
    await c.deleteCollection(name);
  }
  ensured.delete(name);
}
