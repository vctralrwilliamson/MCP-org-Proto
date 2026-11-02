import express from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { isValidInvite, setSession, clearSession, getTester, requireTester, testerId } from './auth.js';
import * as store from './store.js';
import { kindOf, extractText, ExtractError } from './extract.js';
import { mountOidc } from './oidc.js';
import { callTool } from './mcpClient.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 },
});

store.load();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
      "form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // The OAuth callback URL carries the authorization code.
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.static(publicDir));

// Cookies are SameSite=Lax; this also refuses state changes sent from another site.
app.use(['/api', '/auth'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const { origin, host } = req.headers;
  if (req.method === 'GET' || !origin) return next();
  let sameOrigin = false;
  try {
    sameOrigin = new URL(origin).host === host;
  } catch {}
  if (!sameOrigin) return res.status(403).json({ error: 'Cross-site request refused.' });
  next();
});

app.use(express.json({ limit: '64kb' }));

function limiter(windowMinutes, limit, perTester = false) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests. Wait a little and try again.' },
    ...(perTester ? { keyGenerator: (req) => testerId(req.tester) } : {}),
  });
}

// Campus networks can put many testers behind one IP, so OAuth redirects get more room than code guessing.
const oauthLimit = limiter(15, 200);
const inviteLimit = limiter(15, 20);
const askLimit = limiter(1, 20, true);
const uploadLimit = limiter(60, 30, true);
const writeLimit = limiter(60, 120, true);

// Uploads are held in memory while they're extracted, so only a few run at once.
const MAX_CONCURRENT_UPLOADS = 2;
let uploadsInFlight = 0;

function uploadSlot(_req, res, next) {
  if (uploadsInFlight >= MAX_CONCURRENT_UPLOADS) {
    return res.status(429).json({ error: 'Other uploads are in progress. Try again in a minute.' });
  }
  uploadsInFlight++;
  res.once('close', () => uploadsInFlight--);
  next();
}

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/** Loads the instance named in the URL and checks the signed-in tester owns it. */
function ownInstance(req, res, next) {
  const instance = store.getInstance(req.params.id);
  if (!instance || instance.owner !== testerId(req.tester)) {
    return res.status(404).json({ error: 'Instance not found.' });
  }
  req.instance = instance;
  next();
}

function publicInstance(i) {
  return {
    id: i.id,
    name: i.name,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    documents: i.documents,
  };
}

// --- session ---

if (config.authMode === 'oidc') {
  app.use('/auth', oauthLimit);
  mountOidc(app);
}

app.post('/api/login', inviteLimit, (req, res) => {
  if (config.authMode !== 'invite') return res.status(404).json({ error: 'Invite sign-in is disabled.' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Enter your name or email.' });
  if (!isValidInvite(req.body?.code)) return res.status(401).json({ error: 'That invite code is not valid.' });
  setSession(res, name.slice(0, 120));
  res.json({ tester: name });
});

app.post('/api/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ tester: getTester(req), authMode: config.authMode });
});

// --- instances ---

app.get('/api/instances', requireTester, (req, res) => {
  res.json({ instances: store.instancesFor(testerId(req.tester)).map(publicInstance) });
});

app.post(
  '/api/instances',
  requireTester,
  writeLimit,
  wrap(async (req, res) => {
    const owner = testerId(req.tester);
    if (store.instancesFor(owner).length >= config.maxInstancesPerTester) {
      return res.status(409).json({
        error: `You already have ${config.maxInstancesPerTester} instances. Delete one first.`,
      });
    }
    const id = randomBytes(5).toString('hex');
    const now = Date.now();
    const instance = {
      id,
      name: String(req.body?.name || '').trim().slice(0, 80) || `Instance ${id}`,
      owner,
      collection: `${config.collectionPrefix}${id}`,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + config.instanceTtlDays * 86400000).toISOString(),
      documents: [],
    };
    await store.addInstance(instance);
    res.status(201).json({ instance: publicInstance(instance) });
  })
);

app.get('/api/instances/:id', requireTester, ownInstance, (req, res) => {
  res.json({ instance: publicInstance(req.instance) });
});

app.delete(
  '/api/instances/:id',
  requireTester,
  writeLimit,
  ownInstance,
  wrap(async (req, res) => {
    await callTool('drop_collection', { collection: req.instance.collection });
    await store.removeInstance(req.instance.id);
    res.json({ ok: true });
  })
);

// --- documents ---

app.post(
  '/api/instances/:id/documents',
  requireTester,
  uploadLimit,
  ownInstance,
  uploadSlot,
  upload.array('files'),
  wrap(async (req, res) => {
    const instance = req.instance;
    const results = [];
    for (const file of req.files || []) {
      // multer decodes multipart filenames as latin1.
      const title = Buffer.from(file.originalname, 'latin1')
        .toString('utf-8')
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .slice(0, 200);
      const kind = kindOf(title);
      if (!kind) {
        results.push({ title, error: 'Only .docx, .xlsx and .txt files are supported.' });
        continue;
      }
      if (instance.documents.length >= config.maxDocsPerInstance) {
        results.push({ title, error: `This instance is at its ${config.maxDocsPerInstance}-document limit.` });
        continue;
      }
      let text;
      try {
        text = await extractText(file.buffer, kind);
      } catch (err) {
        if (!(err instanceof ExtractError)) console.warn(`[portal] extraction failed: ${err.message}`);
        results.push({
          title,
          error: err instanceof ExtractError ? err.message : 'This file could not be read.',
        });
        continue;
      }
      if (!text) {
        results.push({ title, error: 'No text could be extracted from this file.' });
        continue;
      }
      const documentId = randomBytes(6).toString('hex');
      const message = await callTool('index_document', {
        documentId,
        title,
        text,
        collection: instance.collection,
      });
      const doc = {
        id: documentId,
        title,
        kind,
        chunks: Number(message.match(/Indexed (\d+) chunk/)?.[1] ?? 0),
        uploadedAt: new Date().toISOString(),
      };
      instance.documents.push(doc);
      results.push({ title, document: doc });
    }
    await store.save();
    res.json({ results, instance: publicInstance(instance) });
  })
);

app.delete(
  '/api/instances/:id/documents/:docId',
  requireTester,
  writeLimit,
  ownInstance,
  wrap(async (req, res) => {
    const instance = req.instance;
    const doc = instance.documents.find((d) => d.id === req.params.docId);
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    await callTool('remove_document', { documentId: doc.id, collection: instance.collection });
    instance.documents = instance.documents.filter((d) => d.id !== doc.id);
    await store.save();
    res.json({ instance: publicInstance(instance) });
  })
);

// --- chat + feedback ---

app.post(
  '/api/instances/:id/ask',
  requireTester,
  askLimit,
  ownInstance,
  wrap(async (req, res) => {
    const question = String(req.body?.question || '').trim().slice(0, 2000);
    if (!question) return res.status(400).json({ error: 'Ask a question.' });
    const text = await callTool('ask', { question, collection: req.instance.collection });
    res.json(JSON.parse(text));
  })
);

app.post(
  '/api/instances/:id/feedback',
  requireTester,
  writeLimit,
  ownInstance,
  wrap(async (req, res) => {
    const entry = {
      id: randomBytes(6).toString('hex'),
      instanceId: req.instance.id,
      tester: req.tester,
      question: String(req.body?.question || '').slice(0, 2000),
      answer: String(req.body?.answer || '').slice(0, 8000),
      note: String(req.body?.note || '').trim().slice(0, 1000),
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    await store.addFeedback(entry);
    res.status(201).json({ ok: true });
  })
);

app.get('/api/instances/:id/feedback', requireTester, ownInstance, (req, res) => {
  res.json({ feedback: store.feedbackFor(req.instance.id) });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ error: err.message });
  }
  // Malformed JSON, oversized body and the like. Never echo the parser's message.
  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: 'Bad request.' });
  }
  console.error('[portal]', err);
  res.status(502).json({ error: 'Something went wrong talking to the search backend. Try again.' });
});

// --- expiry ---

async function sweepExpired() {
  for (const instance of store.expiredInstances()) {
    try {
      await callTool('drop_collection', { collection: instance.collection });
      await store.removeInstance(instance.id);
      console.log(`[portal] expired instance ${instance.id} (${instance.owner}) removed`);
    } catch (err) {
      console.warn(`[portal] could not remove expired instance ${instance.id}: ${err.message}`);
    }
  }
}
setInterval(sweepExpired, 60 * 60 * 1000);
setTimeout(sweepExpired, 30 * 1000);

app.listen(config.port, () => {
  console.log(`portal listening on port ${config.port}`);
});
