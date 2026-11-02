import { Worker } from 'node:worker_threads';
import { config } from './config.js';

// Same extraction rules as site's lib/documentPreview.ts (extractTextForRag),
// but from an in-memory upload instead of a file on disk. Uploads are untrusted,
// so parsing runs in a worker that can be killed, away from the web server.

const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10000;
const WORKER_TIMEOUT_MS = 60 * 1000;

/** A problem with the file itself; the message is safe to show the tester. */
export class ExtractError extends Error {}

export function kindOf(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  return ['txt', 'docx', 'xlsx'].includes(ext) ? ext : null;
}

/**
 * Rejects zip bombs before anything inflates them: .docx and .xlsx are zips, and
 * the central directory declares each entry's unzipped size. A file that lies
 * there is still bounded by the worker's memory limit and timeout.
 */
function assertSafeZip(buffer) {
  const invalid = new ExtractError('This file is not a valid Office document.');
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > buffer.length) throw invalid;

  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  // 0xffff / 0xffffffff mean ZIP64, which no normal Office document needs.
  if (entries === 0xffff || offset === 0xffffffff || entries > MAX_ZIP_ENTRIES) {
    throw new ExtractError('This file is too large to process.');
  }

  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw invalid;
    total += buffer.readUInt32LE(offset + 24);
    if (total > MAX_UNZIPPED_BYTES) throw new ExtractError('This file is too large to process.');
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
}

function runWorker(buffer, kind) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./extract-worker.js', import.meta.url), {
      workerData: { buffer, kind },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new ExtractError('This file took too long to process.'));
    }, WORKER_TIMEOUT_MS);
    worker.once('message', (text) => {
      clearTimeout(timer);
      resolve(text);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ERR_WORKER_OUT_OF_MEMORY') reject(new ExtractError('This file is too large to process.'));
      else reject(err);
    });
  });
}

export async function extractText(buffer, kind) {
  if (kind !== 'txt') assertSafeZip(buffer);
  const text = await runWorker(buffer, kind);
  if (!text) throw new ExtractError('No text could be extracted from this file.');
  if (text.length > config.maxTextChars) {
    throw new ExtractError(`This file has too much text (limit: ${config.maxTextChars.toLocaleString('en-US')} characters).`);
  }
  return text;
}
