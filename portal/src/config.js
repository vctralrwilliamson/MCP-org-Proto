const problems = [];

function required(name) {
  const val = process.env[name];
  if (!val) problems.push(`Missing required env var: ${name}`);
  return val;
}

const list = (val) =>
  (val || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

const authMode = process.env.AUTH_MODE || (process.env.OIDC_ISSUER ? 'oidc' : 'invite');

export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: process.env.DATA_DIR || './data',
  // mcp's /mcp endpoint. Inside docker-compose this is the internal service name.
  mcpServerUrl: process.env.MCP_SERVER_URL || 'http://mcp:3900/mcp',
  mcpApiKey: required('MCP_API_KEY'),
  // Must match mcp's INSTANCE_COLLECTION_PREFIX.
  collectionPrefix: process.env.INSTANCE_COLLECTION_PREFIX || 'inst_',
  // "oidc" (OAuth 2.0 / OpenID Connect sign-in) or "invite" (shared codes,
  // for local testing). Defaults to oidc whenever an issuer is configured.
  authMode,
  // Comma-separated invite codes. Anyone with a code can sign in as a tester.
  inviteCodes: list(authMode === 'invite' ? required('INVITE_CODES') : process.env.INVITE_CODES),
  // Public origin testers reach the portal at; OAuth redirects come back here.
  publicUrl: authMode === 'oidc' ? required('PUBLIC_URL') : process.env.PUBLIC_URL,
  oidc: {
    issuer: authMode === 'oidc' ? required('OIDC_ISSUER') : undefined,
    clientId: authMode === 'oidc' ? required('OIDC_CLIENT_ID') : undefined,
    clientSecret: process.env.OIDC_CLIENT_SECRET || undefined,
    scopes: process.env.OIDC_SCOPES || 'openid email profile',
    // Who may sign in. At least one is required unless allowAnyAccount is set.
    allowedDomains: list(process.env.OIDC_ALLOWED_DOMAINS).map((d) => d.toLowerCase()),
    allowedEmails: list(process.env.OIDC_ALLOWED_EMAILS).map((e) => e.toLowerCase()),
    allowAnyAccount: process.env.OIDC_ALLOW_ANY_ACCOUNT === 'true',
    // For a single-tenant provider that doesn't send email_verified (Microsoft
    // Entra). Never set this for a multi-tenant or public provider.
    trustEmailClaim: process.env.OIDC_TRUST_EMAIL_CLAIM === 'true',
  },
  // Signs the session cookie. Any long random string.
  sessionSecret: required('SESSION_SECRET'),
  sessionDays: Number(process.env.SESSION_DAYS || 7),
  instanceTtlDays: Number(process.env.INSTANCE_TTL_DAYS || 14),
  maxInstancesPerTester: Number(process.env.MAX_INSTANCES_PER_TESTER || 3),
  maxDocsPerInstance: Number(process.env.MAX_DOCS_PER_INSTANCE || 50),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 20),
  // Largest extracted text accepted per document (mcp's body limit is 10mb).
  maxTextChars: Number(process.env.MAX_TEXT_CHARS || 2000000),
  // Reverse proxies in front of the portal; Caddy is the only one in compose.
  trustProxy: Number(process.env.TRUST_PROXY ?? 1),
  // Set to false when serving plain http (e.g. local testing without Caddy).
  secureCookies: process.env.SECURE_COOKIES !== 'false',
};

if (!['oidc', 'invite'].includes(authMode)) problems.push(`AUTH_MODE must be "oidc" or "invite", got "${authMode}"`);
if (config.sessionSecret && config.sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
if (
  authMode === 'oidc' &&
  !config.oidc.allowAnyAccount &&
  config.oidc.allowedDomains.length === 0 &&
  config.oidc.allowedEmails.length === 0
) {
  problems.push('Set OIDC_ALLOWED_DOMAINS or OIDC_ALLOWED_EMAILS (or OIDC_ALLOW_ANY_ACCOUNT=true)');
}
if (problems.length > 0) {
  for (const p of problems) console.error(`[config] ${p}`);
  process.exit(1);
}
if (authMode === 'invite') {
  console.warn('[config] AUTH_MODE=invite: testers are identified by a typed name and can open each other\'s instances. Local testing only.');
}
