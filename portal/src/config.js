function required(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`[config] Missing required env var: ${name}`);
  }
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
  mcpApiKey: process.env.MCP_API_KEY || undefined,
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
    // Leave both empty to let any account the provider signs in through.
    allowedDomains: list(process.env.OIDC_ALLOWED_DOMAINS).map((d) => d.toLowerCase()),
    allowedEmails: list(process.env.OIDC_ALLOWED_EMAILS).map((e) => e.toLowerCase()),
  },
  // Signs the session cookie. Any long random string.
  sessionSecret: required('SESSION_SECRET'),
  sessionDays: Number(process.env.SESSION_DAYS || 7),
  instanceTtlDays: Number(process.env.INSTANCE_TTL_DAYS || 14),
  maxInstancesPerTester: Number(process.env.MAX_INSTANCES_PER_TESTER || 3),
  maxDocsPerInstance: Number(process.env.MAX_DOCS_PER_INSTANCE || 50),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 20),
  // Set to false when serving plain http (e.g. local testing without Caddy).
  secureCookies: process.env.SECURE_COOKIES !== 'false',
};
