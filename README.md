# Play Sequence Override

A stateless Docker service that embeds Bilibili audio with EfficientAT, plus a
Microsoft Edge / Chromium MV3 extension that orders playback with the ported C
recommender.

The backend exposes only `POST /v1/embed`. It verifies a delegated jawbts-api
JWT, downloads the requested Bilibili audio, computes a 960-D vector, and
deletes the temporary audio. It keeps no catalog, vectors, history, or playback
state. The extension keeps all of that in IndexedDB.

## Deploy

Requirements: Docker with Compose, a jawbts-api instance, a jawbts-gateway
instance, and an HTTPS hostname for the embedding service.

### 1. Embedding service

```bash
cp .env.example .env
# Set JWKS_URL, REQUIRED_SCOPE, CATALOG_PATH and other values as needed.
docker compose up --build -d
docker compose ps
```

The service binds to `127.0.0.1:8000`. Put a TLS reverse proxy in front of it
for remote access. The container is read-only and writes only to a tmpfs; no
application data is persisted.

Verify it directly:

```bash
curl -sS http://127.0.0.1:8000/v1/embed \
  -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d '{"internal_id":"BBV16y4y127Dz"}'
```

### 2. Gateway allowlist

The extension signs in through jawbts-gateway. Add its OAuth callback host to
the gateway allowlist, then redeploy the gateway:

```ts
{ host: '<extension-id>.chromiumapp.org', includeSubdomains: false, allowHttp: false },
```

The exact host is shown in the extension's **Settings & allowlist** page. The
embedding endpoint is not a redirect target and does not go on that allowlist.
The exact callback host and scope requirements are in the extension's **Settings & allowlist** page.

### 3. Extension

1. Open `edge://extensions`, enable Developer mode, and **Load unpacked**
   `extension`.
2. Open **Settings & allowlist** and set the gateway and embedding URLs.
3. Add the allowlist host to the gateway configuration if you have not already
   done so.
4. Click **Sign in** and complete the protected OAuth webview.
5. Open a Bilibili video page. Use **Next** or enable **Auto-advance**.

Only one detected video tab drives the sequence. The first page detected keeps
it, the other video tabs stay disabled, and closing that page hands control to
the next surviving tab.

For a loopback-only development deployment without OAuth:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d
```

Then set the embedding URL to `http://localhost:8000/v1/embed` and enable
**Local development** in the extension. Never expose `DEV_MODE` publicly.

## Development

`extension/` is the loadable plugin; there is no build and nothing to keep in
sync.

```bash
cd extension
npm run check
npm test
```

## Versioning

`VERSION` at the repository root is the single source of truth. The plugin
manifests and the Docker image label derive from it:

```bash
$EDITOR VERSION                        # e.g. 0.4.0
python3 scripts/version.py --write     # sync extension/manifest.json and package.json
```

Commit both changes. A push to `main` that modifies `VERSION` makes CI create
the matching `v<version>` tag on that commit, which is what the Docker workflow
builds and tags from. CI fails when a tag does not match `VERSION` or when a
version bump leaves a manifest behind.

## License

Play Sequence Override is licensed under the **GNU General Public License,
version 3 only**. See [LICENSE](LICENSE).

EfficientAT is vendored under the MIT License; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
