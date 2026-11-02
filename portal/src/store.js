import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// A dev sandbox holds a handful of testers, so one JSON file on a volume is
// plenty. Swap for Postgres/SQLite if this ever becomes multi-replica.
const file = path.join(config.dataDir, 'portal.json');

let state = { instances: [], feedback: [] };
let writing = Promise.resolve();

export function load() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (fs.existsSync(file)) {
    state = JSON.parse(fs.readFileSync(file, 'utf-8'));
    state.instances ??= [];
    state.feedback ??= [];
  }
}

/** Persists the whole state; writes are serialised and atomic (tmp + rename). */
export function save() {
  const snapshot = JSON.stringify(state, null, 2);
  writing = writing.then(async () => {
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, snapshot);
    await fs.promises.rename(tmp, file);
  });
  return writing;
}

export function instancesFor(owner) {
  return state.instances.filter((i) => i.owner === owner);
}

export function getInstance(id) {
  return state.instances.find((i) => i.id === id) || null;
}

export function addInstance(instance) {
  state.instances.push(instance);
  return save();
}

export function removeInstance(id) {
  state.instances = state.instances.filter((i) => i.id !== id);
  return save();
}

export function expiredInstances(now = Date.now()) {
  return state.instances.filter((i) => new Date(i.expiresAt).getTime() <= now);
}

export function addFeedback(entry) {
  state.feedback.push(entry);
  return save();
}

export function feedbackFor(instanceId) {
  return state.feedback.filter((f) => f.instanceId === instanceId);
}
