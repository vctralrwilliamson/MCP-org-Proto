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
    const options = issuer.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : undefined;
    discovered = client.discovery(new URL(issuer), clientId, clientSecret, undefined, options).catch((err) => {
      discovered = null;
      throw err;
    });
  }
  return discovered;
}

/** Decides whether a signed-in identity may use the sandbox. */
function isAllowed(email) {
  const { allowedEmails, allowedDomains } = config.oidc;
  if (allowedEmails.length === 0 && allowedDomains.length === 0) return true;
  const domain = email.split('@')[1] || '';
  return allowedEmails.includes(email) || allowedDomains.includes(domain);
}

function fail(res, message) {
  clearCookie(res, FLOW);
  res.redirect(`/?auth_error=${encodeURIComponent(message)}`);
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
    if (!flow) return fail(res, 'Your sign-in took too long or was started in another browser. Try again.');
    if (req.query.error) return fail(res, String(req.query.error_description || req.query.error));

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
      return fail(res, 'Sign-in failed. Try again.');
    }

    // Entra puts the address in preferred_username when the email claim is absent.
    const email = String(claims.email || claims.preferred_username || '').trim().toLowerCase();
    if (!email.includes('@')) return fail(res, 'Your account did not share an email address.');
    if (claims.email_verified === false) return fail(res, 'Your email address is not verified with your provider.');
    if (!isAllowed(email)) return fail(res, `${email} is not allowed to use this sandbox.`);

    clearCookie(res, FLOW);
    setSession(res, email);
    res.redirect('/');
  });
}
