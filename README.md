# Webhook Relayer (Generic HTTP Relay)

A tiny, containerized relay that receives HTTP requests on arbitrary paths and forwards them to configured target URLs. Use it to centralize inbound webhooks and route them to different environments or services.

## Features

- Dynamic path → URL routing via environment variables
- Preserves the incoming HTTP method (GET/POST/PUT/PATCH/DELETE, etc.)
- Supports Basic Auth embedded in destination URLs
- Longest-prefix path matching (map `/custom` and it will also match `/custom/anything`)
- Always responds `200` to the caller to avoid unnecessary retries
- Structured JSON logging with request ID, matched route, method, duration, and target status
- Health endpoints: `/health`, `/ready`, `/config`

## Quick Start (Docker Hub Image)

Pull and run the image from Docker Hub:

```bash
docker run -d \
  --name webhook-relayer \
  -p 3000:3000 \
  -e TARGET_TIMEOUT_MS=10000 \
  -e RELAY_ROUTES="dev=https://admin:pass@dev.example.com/api/webhooks,prod=https://admin:pass@prod.example.com/api/webhooks" \
  adnanhussainturki/webhook-relayer:latest
```

Check health and config:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/config
curl http://localhost:3000/ready
```

Send a test request (method is preserved and forwarded):

```bash
curl -X POST http://localhost:3000/dev \
  -H 'content-type: application/json' \
  -d '{"events":[{"type":"test.event"}]}'
```

## Routing Configuration

Choose any of the forms below (combine if desired; later sources override earlier ones). Keys are path prefixes without leading/trailing slashes.

- JSON mapping

```bash
RELAY_ROUTES_JSON={"dev":"https://admin:pass@dev.example.com/api/webhooks","prod":"https://admin:pass@prod.example.com/api/webhooks"}
```

- CSV mapping (supports `=` or `->` separators)

```bash
RELAY_ROUTES="dev=https://admin:pass@dev.example.com/api/webhooks,prod->https://admin:pass@prod.example.com/api/webhooks"
```

- Prefixed envs

```bash
RELAY_TARGET_DEV=https://admin:pass@dev.example.com/api/webhooks
RELAY_TARGET_PROD=https://admin:pass@prod.example.com/api/webhooks
```

Notes:
- Longest-prefix wins. If you define `custom` and `custom/path`, a request to `/custom/path/extra` matches `custom/path`.
- If no matching route is found, the relayer still returns `200` with `{ forwarded: false }` and logs the condition.
- If the target URL contains Basic Auth `https://user:pass@host/...`, it is honored when forwarding.

## Endpoints

- `ANY /<your-path>`: Forwards to the configured target URL for that path prefix
- `GET /health`: Liveness probe
- `GET /ready`: Ready when at least one route is configured
- `GET /config`: Returns masked configured routes and basic runtime info

## Docker Compose (pull from Docker Hub)

```yaml
services:
  webhook-relayer:
    image: adnanhussainturki/webhook-relayer:latest
    ports:
      - "3000:3000"
    environment:
      TARGET_TIMEOUT_MS: 10000
      RELAY_ROUTES: dev=https://admin:pass@dev.example.com/api/webhooks,prod=https://admin:pass@prod.example.com/api/webhooks
    restart: unless-stopped
```

Bring it up:

```bash
docker compose up -d
```

## Deploy on Dokploy (example)

- Image: `adnanhussainturki/webhook-relayer:latest`
- Port: map `3000`
- Environment variables (example):
  - `TARGET_TIMEOUT_MS=10000`
  - `RELAY_ROUTES=dev=https://admin:pass@dev.example.com/api/webhooks,prod=https://admin:pass@prod.example.com/api/webhooks`
- Health checks:
  - Liveness: `GET /health`
  - Readiness: `GET /ready`

## Logging

Logs are JSON for easy ingestion:

```json
{
  "timestamp": "2025-01-01T10:30:00.000Z",
  "level": "info",
  "message": "Received webhook",
  "requestId": "c4c3d6...",
  "path": "dev",
  "matchedRoute": "dev",
  "method": "POST",
  "durationMs": 245,
  "targetStatus": 200
}
```

## Troubleshooting

- "No target URL configured": Confirm your route envs are set correctly and match the incoming path
- 401/403 at destination: Verify Basic Auth in the target URL
- Timeouts: Increase `TARGET_TIMEOUT_MS` or check destination responsiveness

## Security Considerations

- Prefer HTTPS targets
- Store credentials in a secrets manager or platform-level secrets
- Limit public exposure of this service; use ingress rules or firewalling as needed

## License

MIT
