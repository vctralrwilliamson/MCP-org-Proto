# libChatBot dev sandbox

A self-contained stack that lets testers try the RAG chatbot on **their own
documents** without touching production:

1. Sign in with single sign-on (OAuth 2.0 / OpenID Connect).
2. Create an instance.
3. Upload `.docx`, `.xlsx` or `.txt` files.
4. Chat. Answers come only from that instance's documents.
5. Flag bad answers with **Not helpful**.
6. Delete the instance, or let it expire after `INSTANCE_TTL_DAYS`.

Each instance is its own Qdrant collection (`inst_<id>`) on a **local** Qdrant
container, never `qdrant.wazzahappenin.com`.

```
 browser ──https──▶ caddy ──▶ portal ──MCP/HTTP (x-mcp-key)──▶ mcp ──▶ qdrant
                                                                 └──▶ ollama (container or existing machine)
```

Only Caddy publishes ports. `portal`, `mcp`, `qdrant` and `ollama` are on
the internal Docker network only.

## What's here

| Path | What it is |
|---|---|
| `mcp/` | The MCP server from `Projects/mcprag`, plus per-instance collections (see below). |
| `portal/` | Tester front end and API (Express, vanilla JS, works on phones). |
| `docker-compose.yml` | caddy, portal, mcp, qdrant, and optional ollama. |
| `Caddyfile` | TLS and reverse proxy for `DEV_DOMAIN`. |
| `.env.example` | Every setting. Copy it to `.env`. |

### Changes to the MCP server

- Every tool takes an optional `collection` argument. It's accepted only
  when `INSTANCE_COLLECTION_PREFIX` is set and the name starts with that
  prefix, so callers can't reach other collections on the same Qdrant.
  **When the variable is unset (production), behaviour is unchanged.**
- New `drop_collection` tool, used when an instance is deleted or expires.
  It refuses the default collection.
- `search()` now uses `client.query()`. `client.search()` was removed in
  `@qdrant/js-client-rest` 1.19, which is what `Projects/mcprag`'s lockfile
  already installs, so `ask` / `search_docs` fail there too until it gets
  the same fix.
- The client is pinned to `~1.19.0` and Qdrant to `v1.19.2`. The client
  refuses servers more than one minor version apart.

## Deploy on a new machine

Needs Docker with the compose plugin. Ports 80/443 must be open, and DNS for
`DEV_DOMAIN` must point at the machine.

```bash
cp .env.example .env
# fill in MCP_API_KEY, SESSION_SECRET (openssl rand -hex 32) and the OIDC_* settings (see Sign-in below)

# A) Ollama runs in this stack (pulls nomic-embed-text + llama3.2 on first start)
docker compose --profile ollama up -d --build

# B) or use the existing Ollama machine: set OLLAMA_URL in .env, then
docker compose up -d --build
```

Open `https://<DEV_DOMAIN>`, sign in, and create an instance.

For a quick local run, set `AUTH_MODE=invite` and `INVITE_CODES`, and set `DEV_DOMAIN=localhost` (Caddy issues a self-signed
cert). The Ollama on your laptop listens on `127.0.0.1` only, so containers
can't reach it. Use `--profile ollama`, or start Ollama with
`OLLAMA_HOST=0.0.0.0`.

## Sign-in

`AUTH_MODE=oidc` (the default) uses the OAuth 2.0 authorization code flow
with PKCE, via OpenID Connect discovery
([portal/src/oidc.js](portal/src/oidc.js)). Any OIDC provider works.

1. Register a web app with your provider, with the redirect URI
   `https://<DEV_DOMAIN>/auth/callback`.
2. Put its issuer, client ID and client secret in `.env`:
   - **Microsoft Entra:** `OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`.
     Use your tenant ID, not `common`, so only your organization's accounts get in.
   - **Google:** `OIDC_ISSUER=https://accounts.google.com`
3. Restrict who can sign in with `OIDC_ALLOWED_DOMAINS` (e.g. `vcu.edu`)
   and/or `OIDC_ALLOWED_EMAILS`. If both are empty, anyone the provider
   authenticates can use the sandbox.

Testers are identified by their email address (lowercased), so their
instances follow them across devices. Sign-in is refused if the provider
reports the email as unverified.

`AUTH_MODE=invite` keeps the old shared-code login for local testing. In
that mode, instances are keyed by the name a tester types.

## Data and admin

- Portal state (instances, documents, feedback) lives in
  `/data/portal.json` in the `portal_data` volume. Read the open "Not
  helpful" flags with:
  `docker compose exec portal cat /data/portal.json`
- Vectors live in the `qdrant_data` volume.
- An hourly sweep drops instances past their `expiresAt`.
- `docker compose down -v` wipes everything.

## Not built yet (from the admin console mockup)

- Admin screens: department list, document pinning (CAG), feedback queue
  with "Mark fixed", extend and promote for sandbox instances. Feedback
  already stores a `status: "open"` field for "Mark fixed".
- Sign-out ends the portal session only. It doesn't sign the tester out of
  the identity provider.
