# Mem0 Gateway (LibreChat)

This service is an OpenAI-compatible proxy that injects memories into chat
requests for LibreChat. It is designed to keep LibreChat untouched so upgrades
stay clean.

## What it does

- Receives `POST /v1/chat/completions` (and `/v1/responses`) from LibreChat.
- Looks up relevant memories from Mem0 OSS, Mem0 Platform, or OpenMemory API.
- Injects those memories into the prompt.
- Forwards the request to your upstream model provider.
- Optionally stores new memories in the selected memory backend.

## Quick start

1) Enter the gateway directory

```bash
cd mem0-gateway
```

2) Install dependencies

```bash
npm install
```

3) Copy env template and edit

```bash
copy config\.env.example .env
```

```bash
cp config/.env.example .env
```

For OpenRouter (gateway upstream), set:

```text
UPSTREAM_BASE_URL=https://openrouter.ai/api/v1
UPSTREAM_API_KEY=your-openrouter-key
UPSTREAM_HEADERS={"HTTP-Referer":"https://your-domain","X-Title":"LibreChat"}
```

4) Run

```bash
npm start
```

## Docker compose (OpenMemory + UI)

```bash
cd mem0-gateway/compose
copy openmemory.env.example openmemory.env
copy ..\config\.env.example ..\.env
docker compose up
```

```bash
cd mem0-gateway/compose
cp openmemory.env.example openmemory.env
cp ../config/.env.example ../.env
docker compose up
```

This starts:
- OpenMemory API: `http://localhost:8765`
- OpenMemory UI: `http://localhost:3000`
- Gateway: `http://localhost:8001`

## LibreChat config (minimal change)

```yaml
endpoints:
  custom:
    - name: mem0-gateway
      apiKey: ${MEM0_GATEWAY_API_KEY}
      baseURL: http://mem0-gateway:8001/v1
      headers:
        X-User-Id: "{{LIBRECHAT_USER_ID}}"
        X-Conversation-Id: "{{LIBRECHAT_BODY_CONVERSATIONID}}"
      models:
        default:
          - gpt-4.1-mini

memory:
  disabled: true
```

## Environment variables

- `GATEWAY_API_KEY`: required if you want to protect the gateway.
- `UPSTREAM_BASE_URL`: model API base URL (e.g. `https://api.openai.com`).
- `UPSTREAM_API_KEY`: model API key.
- `UPSTREAM_HEADERS`: optional JSON string of extra headers.
  - OpenRouter often expects `HTTP-Referer` and `X-Title`.
- `MEM0_MODE`: `oss`, `platform`, or `openmemory`.
- `MEM0_API_BASE`: backend API base URL (`http://mem0-api:8000` or `http://openmemory-api:8765`).
- `MEM0_API_KEY`: Mem0 API key (platform or protected OSS).
- `MEM0_SEARCH_TOP_K`: search top-k for Mem0 platform mode.
- `MEM0_MAX_MEMORIES`: max memories to inject.
- `MEM0_THRESHOLD`: similarity cutoff.
- `MEM0_STORE_MODE`: `user_only` or `both`.
- `MEM0_INJECT_ROLE`: usually `system`.
- `OPENMEMORY_USER_ID`: when set, gateway uses this fixed user for all memory operations.
- `OPENMEMORY_APP`: app label stored in OpenMemory (`librechat` by default).
- `AVAILABLE_MODELS`: comma-separated list for `/v1/models`.

## Notes

- Streaming is supported. When `MEM0_STORE_MODE=both`, the gateway will try to
  reconstruct assistant output from the stream before writing to Mem0.
- `/v1/responses` is supported. If your upstream does not implement it, keep
  `useResponsesApi` disabled in LibreChat.
- Default port is `8001` to avoid clashing with Mem0 OSS (default `8000`).
