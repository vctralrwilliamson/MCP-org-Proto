import * as client from 'openid-client';
import { config } from './config.js';
import { setSigned, readSigned, clearCookie, setSession } from './auth.js';

// OAuth 2.0 authorization code flow with PKCE, via OpenID Connect discovery.
// Works with any OIDC provider: Microsoft Entra, Google, Okta, Keycloak, or a
// university IdP that speaks OIDC.

const FLOW = 'portal_oidc';
const redirectUri = () => new URL('/auth/callback', config.publicUrl).toString();

let discovered = null;

function getConfig() {
  if (!discovered) {
    const { issuer, clientId, clientSecret } = config.oidc;
    // Plain http is only ever allowed for a provider on this machine (local testing).
    const { protocol, hostname } = new URL(issuer);
    const isLocal = protocol === 'http:' && ['localhost', '127.0.0.1'].includes(hostname);
    const options = isLocal ? { execute: [client.allowInsecureRequests] } : undefined;
    discovered = client.discovery(new URL(issuer), clientId, clientSecret, undefined, options).catch((err) => {
      discovered = null;
      throw err;
    });
  }
  return discovered;
}

/** Decides whether a signed-in identity may use the sandbox. */
export function isAllowed(email) {
  const { allowedEmails, allowedDomains, allowAnyAccount } = config.oidc;
  if (allowAnyAccount) return true;
  return allowedEmails.includes(email) || allowedDomains.includes(email.split('@')[1]);
}

/** Returns the identity's email if the provider vouches for it, otherwise null. */
export function verifiedEmail(claims) {
  const { trustEmailClaim } = config.oidc;
  if (claims.email_verified !== true && !trustEmailClaim) return null;
  const raw = claims.email || (trustEmailClaim ? claims.preferred_username : '');
  const email = String(raw || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(email) ? email : null;
}

// Only a fixed code goes in the URL; public/app.js maps it to the message shown.
function fail(res, code) {
  clearCookie(res, FLOW);
  res.redirect(`/?auth_error=${code}`);
}

export function mountOidc(app) {
  app.get('/auth/login', async (_req, res, next) => {
    try {
      const oidc = await getConfig();
      const codeVerifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      // The verifier, state and nonce live in a signed 10-minute cookie until the callback.
      setSigned(res, FLOW, { codeVerifier, state, nonce }, 600);
      const url = client.buildAuthorizationUrl(oidc, {
        redirect_uri: redirectUri(),
        scope: config.oidc.scopes,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      res.redirect(url.toString());
    } catch (err) {
      next(err);
    }
  });

  app.get('/auth/callback', async (req, res) => {
    const flow = readSigned(req, FLOW);
    if (!flow) return fail(res, 'expired');
    if (req.query.error) {
      console.warn('[oidc] provider returned an error:', String(req.query.error).slice(0, 100));
      return fail(res, 'failed');
    }

    let claims;
    try {
      const oidc = await getConfig();
      // Rebuild the URL the provider redirected to; behind Caddy req.protocol/host are internal.
      const currentUrl = new URL(req.originalUrl, config.publicUrl);
      const tokens = await client.authorizationCodeGrant(oidc, currentUrl, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
      });
      claims = tokens.claims();
    } catch (err) {
      console.warn('[oidc] callback failed:', err.message);
      return fail(res, 'failed');
    }

    const email = verifiedEmail(claims);
    if (!email) return fail(res, 'unverified');
    if (!isAllowed(email)) return fail(res, 'not_allowed');

    clearCookie(res, FLOW);
    setSession(res, email);
    res.redirect('/');
  });
}
