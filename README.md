# Hookbox

![Node](https://img.shields.io/badge/Node-18+-339933)
![License](https://img.shields.io/badge/License-MIT-green)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED)

**Self-hosted webhook inbox** — create a capture URL, inspect incoming HTTP requests, verify HMAC signatures, and replay events. Inspired by webhook-tester / RequestBin.

A lightweight open-source tool for local development, freelancers, and small teams.

## Features

- Create an inbox with a unique capture URL (`/h/{id}`)
- Capture **any** HTTP method — method, path, query, headers, body
- Optional **HMAC** verification (`X-Hub-Signature-256` / `X-Signature`)
- Keep the **last 100** events per inbox (body capped at **256 KB**)
- **Replay** a captured event to any `http(s)` target (10s timeout)
- Cookie / Authorization headers redacted in storage
- Docker Compose one-command deploy
- No database — JSON file storage

## Quick start (Docker)

```bash
cd Hookbox
docker compose up --build
# → http://localhost:5070
```

Production without Docker (bind all interfaces if needed):

```bash
HOST=0.0.0.0 PORT=5070 PUBLIC_BASE_URL=https://hooks.example.com npm start
```

## Local development

```bash
npm run install:all

# Terminal 1 — API
npm run dev:server   # :5070 (127.0.0.1)

# Terminal 2 — UI
npm run dev:client   # :5176 (proxies /api and /h)
```

Open **http://127.0.0.1:5176**.

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `PORT` | `5070` | API / production UI port |
| `HOST` | `127.0.0.1` (Docker: `0.0.0.0`) | Listen address |
| `MAX_BODY_BYTES` | `262144` (256 KB) | Capture body size limit |
| `PUBLIC_BASE_URL` | (derived) | Base URL embedded in API responses |
| `CORS_ORIGIN` | (off) | Comma-separated allowed origins if UI is on another host |
| `TRUST_PROXY` | (off) | Set `true` behind a reverse proxy so rate limits use `X-Forwarded-For` |

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/inboxes` | Create inbox → `{ id, captureUrl, hmacSecret, createdAt }` (`hmacSecret` once) |
| GET | `/api/inboxes/:id` | Inbox metadata (no secret) |
| GET | `/api/inboxes/:id/events` | List captured events (newest first) |
| DELETE | `/api/inboxes/:id` | Delete inbox and events |
| POST | `/api/inboxes/:id/events/:eventId/replay` | Replay `{ targetUrl }` → status |
| * | `/h/:id` | Capture endpoint (any method) |

### HMAC verification

On create, each inbox gets an `hmacSecret`. Send either:

- `X-Hub-Signature-256: sha256=<hex>` (GitHub-style), or
- `X-Signature: sha256=<hex>` or bare hex

Signature is HMAC-SHA256 of the **raw request body**. Captured events store `verified`: `true` / `false` / `null` (no signature header).

### Example capture

```bash
# Create inbox
curl -s -X POST http://127.0.0.1:5070/api/inboxes

# Send a webhook (replace INBOX_ID)
curl -s -X POST http://127.0.0.1:5070/h/INBOX_ID \
  -H 'Content-Type: application/json' \
  -d '{"hello":"world"}'

# List events
curl -s http://127.0.0.1:5070/api/inboxes/INBOX_ID/events
```

## Project layout

```
hookbox/
├── client/          React + Vite UI
├── server/          Express API
├── data/            Inbox metadata (gitignored)
└── docker-compose.yml
```

## Security notes

- Run behind HTTPS in production; put rate limits on the reverse proxy as well
- Capture is rate-limited to **120 requests/min per IP**; API routes to **60/min**
- Default bind is loopback (`127.0.0.1`); Docker sets `HOST=0.0.0.0`
- Cookie and Authorization headers are redacted before storage
- Body size is limited (`MAX_BODY_BYTES`); ids are validated
- HMAC secret is returned only on inbox creation (UI drops it from session after hide)
- Replay blocks cloud-metadata / link-local targets; loopback and LAN are allowed for local debugging
- Do not enable `TRUST_PROXY` unless the proxy strips client-supplied `X-Forwarded-For`
- This is a personal/team tool — not a public multi-tenant SaaS

## License

[MIT](LICENSE) © 2026 Hookbox
