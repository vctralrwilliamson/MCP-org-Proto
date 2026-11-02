import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const SESSION = 'portal_session';

function sign(value) {
  return createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function cookieHeader(name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

function appendCookie(res, header) {
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(existing) ? existing : existing ? [existing] : []), header]);
}

/** Stores a JSON payload in an HMAC-signed, expiring cookie. */
export function setSigned(res, name, payload, maxAgeSec) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + maxAgeSec * 1000 })).toString('base64url');
  appendCookie(res, cookieHeader(name, `${body}.${sign(body)}`, maxAgeSec));
}

/** Returns the payload of a signed cookie, or null if missing, tampered with or expired. */
export function readSigned(req, name) {
  const raw = readCookie(req, name);
  if (!raw) return null;
  const [body, sig] = raw.split('.');
  if (!body || !sig || !safeEqual(sign(body), sig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export function clearCookie(res, name) {
  appendCookie(res, cookieHeader(name, '', 0));
}

/** Normalises a tester identity (email, or typed name in invite mode) into the id instances are owned by. */
export function testerId(name) {
  return String(name || '').trim().toLowerCase().slice(0, 120);
}

export function isValidInvite(code) {
  const given = String(code || '').trim();
  return given.length > 0 && config.inviteCodes.some((c) => safeEqual(c, given));
}

export function setSession(res, tester) {
  setSigned(res, SESSION, { tester }, config.sessionDays * 86400);
}

export function clearSession(res) {
  clearCookie(res, SESSION);
}

export function getTester(req) {
  return readSigned(req, SESSION)?.tester ?? null;
}

export function requireTester(req, res, next) {
  const tester = getTester(req);
  if (!tester) return res.status(401).json({ error: 'Sign in first.' });
  req.tester = tester;
  next();
}
