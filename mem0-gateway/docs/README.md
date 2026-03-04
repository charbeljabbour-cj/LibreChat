# Mem0 Gateway (LibreChat)

This service is an OpenAI-compatible proxy that injects memories into chat
requests for LibreChat. It is designed to keep LibreChat untouched so upgrades
stay clean.

## What it does

- Receives `POST /v1/chat/completions` (and `/v1/responses`) from LibreChat.
- Looks up relevant memories from Mem0 OSS, Mem0 Platform, or OpenMemory API.
- Injects those memories into the prompt.
- Forwards the request to your upstream model provider (e.g. OpenRouter).
- Optionally stores new memories in the selected memory backend.

## Architecture

```
LibreChat
    |
    v
mem0-gateway:8001  ------>  OpenRouter (or any OpenAI-compatible API)
    |
    +-- search/store memories
    |
    v
openmemory-api:8765
    |
    v
Qdrant:6333 (vector DB)
```

Three services, no extra databases.

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

**Windows:**
```bash
copy config\.env.example .env
```

**Linux / macOS:**
```bash
cp config/.env.example .env
```

Set your OpenRouter key:

```text
UPSTREAM_BASE_URL=https://openrouter.ai/api/v1
UPSTREAM_API_KEY=your-openrouter-key
UPSTREAM_HEADERS={"HTTP-Referer":"https://your-domain","X-Title":"LibreChat"}
```

4) Run

```bash
npm start
```

## Docker compose (full stack)

**Windows:**
```bash
cd mem0-gateway\compose
copy openmemory.env.example openmemory.env
copy ..\config\.env.example ..\.env
docker compose up
```

**Linux / macOS:**
```bash
cd mem0-gateway/compose
cp openmemory.env.example openmemory.env
cp ../config/.env.example ../.env
docker compose up
```

This starts:
- Gateway: `http://localhost:8001`
- OpenMemory API: `http://localhost:8765`
- Qdrant dashboard (vector inspection): `http://localhost:6333/dashboard`
- Neo4j browser (graph profile only): `http://localhost:7474`

Mem0 compatibility routes exposed by the API service:
- `POST /v1/memories/`
- `GET|PUT|DELETE /v1/memories/{memory_id}/`
- `POST /v2/memories/search/`
- `POST /v2/memories/`

## Azure deployment

If you are hosting LibreChat on Azure (e.g. Azure Container Apps, AKS, or a VM
with Docker), you can add the mem0 gateway alongside your existing deployment.

### What you need

| Service | Runs as | Notes |
|---|---|---|
| **mem0-gateway** | Container | Stateless proxy, scale horizontally |
| **openmemory-api** | Container | Memory backend |
| **Qdrant** | Container | Vector store, persist the volume |

All three communicate over an **internal network** (Azure VNet or Container Apps
environment). Only LibreChat is exposed publicly.

### Step-by-step

1) **Add the three containers** to your existing deployment (Container Apps,
   AKS namespace, or docker-compose on a VM). Use the same `docker-compose.yml`
   from this repo or translate the services into your deployment manifests.

2) **Set environment variables** for the gateway (`.env`):

```text
GATEWAY_API_KEY=<generate-a-strong-key>
UPSTREAM_BASE_URL=https://openrouter.ai/api/v1
UPSTREAM_API_KEY=<your-openrouter-key>
UPSTREAM_HEADERS={"HTTP-Referer":"https://your-domain","X-Title":"LibreChat"}
```

3) **Set environment variables** for OpenMemory (`openmemory.env`):

```text
OPENAI_API_KEY=<your-openrouter-key>
OPENAI_BASE_URL=https://openrouter.ai/api/v1
QDRANT_HOST=mem0-store
QDRANT_PORT=6333
```

4) **Configure LibreChat** (`librechat.yaml`):

```yaml
endpoints:
  custom:
    - name: mem0-gateway
      apiKey: "${MEM0_GATEWAY_API_KEY}"
      baseURL: "http://mem0-gateway:8001/v1"
      headers:
        X-User-Id: "{{LIBRECHAT_USER_ID}}"
        X-Conversation-Id: "{{LIBRECHAT_BODY_CONVERSATIONID}}"
      models:
        default:
          - openrouter/auto
          - gpt-4.1-mini
          - anthropic/claude-sonnet-4

memory:
  disabled: true
```

5) **Store secrets** in Azure Key Vault instead of `.env` files and reference
   them in your container configuration.

6) **Persist Qdrant data** by mounting a persistent volume on the `mem0-store`
   container at `/qdrant/storage`.

### Networking

- The gateway, OpenMemory API, and Qdrant should only be reachable from within
  your internal network. Do not expose ports 8001, 8765, or 6333 publicly.
- LibreChat reaches the gateway over the internal network using its service name
  (e.g. `http://mem0-gateway:8001/v1`).

### Backups

- **Qdrant**: back up the persistent volume (`mem0_storage`).
- **OpenMemory**: back up `/data/openmemory.db` (SQLite file inside the
  `openmemory_db` volume).

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

Gateway (`.env`):

- `GATEWAY_API_KEY`: required if you want to protect the gateway.
- `BODY_LIMIT`: JSON body size limit for gateway requests (default `25mb` for multimodal payloads).
- `UPSTREAM_BASE_URL`: upstream OpenAI-compatible API base URL (e.g. `https://openrouter.ai/api/v1`).
- `UPSTREAM_API_KEY`: upstream API key (your OpenRouter key).
- `UPSTREAM_HEADERS`: optional JSON string of extra headers.
  - OpenRouter expects `HTTP-Referer` and `X-Title`.
- `MEM0_MODE`: `oss`, `platform`, `openmemory`, or `mem0_compat`.
- `MEM0_API_BASE`: backend API base URL (`http://mem0-api:8000` or `http://openmemory-api:8765`).
- `MEM0_API_KEY`: Mem0 API key (platform or protected OSS).
- `MEM0_API_FLAVOR`: `openmemory_legacy` or `mem0_v2`.
- `MEM0_SEARCH_TOP_K`: search top-k for Mem0 platform mode.
- `MEM0_MAX_MEMORIES`: max memories to inject.
- `MEM0_THRESHOLD`: similarity cutoff.
- `MEM0_SEARCH_THRESHOLD`: retrieval threshold for v2 search.
- `MEM0_SEARCH_RERANK`: enable reranker on v2 search.
- `MEM0_ENABLE_GRAPH`: request graph-aware retrieval/add when supported by backend.
- `MEM0_INCLUDE_RELATIONS_IN_PROMPT`: inject graph `relations` context into prompt when available.
- `MEM0_KEYWORD_SEARCH`: enable keyword-assisted retrieval.
- `MEM0_FILTER_MEMORIES`: enable backend-side filter refinement.
- `MEM0_SEARCH_FIELDS`: JSON array of fields to request from v2 search.
- `MEM0_SEARCH_FILTERS`: JSON object merged into request filters.
- `MEM0_STORE_MODE`: `user_only` or `both`.
- `MEM0_ASYNC_MODE`: async memory ingestion flag.
- `MEM0_OUTPUT_FORMAT`: output format (`v1.0` or `v1.1`).
- `MEM0_VERSION`: memory engine version (`v1.1` recommended).
- `MEM0_MEMORY_TYPE`: optional memory type for add operations.
- `MEM0_CUSTOM_CATEGORIES`: JSON object of custom categories.
- `MEM0_IMMUTABLE`: mark memories immutable.
- `MEM0_TIMESTAMP_MODE`: `none` or `now`.
- `MEM0_EXPIRATION_DATE`: optional expiration date for new memories.
- `MEM0_MULTIMODAL_ENABLED`: preserve image parts in memory writes.
- `MEM0_MAX_IMAGE_BYTES`: max base64 data URL image size for memory writes (default 20MB).
- `MEM0_ALLOWED_IMAGE_MIME_TYPES`: comma-separated allowlist for image MIME types.
- `MEM0_ADD_RETRIES`: retry count for transient memory write failures.
- `MEM0_ADD_RETRY_DELAY_MS`: initial retry delay for memory writes.
- `MEM0_FORGET_ENABLED`: enables delete-on-intent handling for user "forget/delete/remove" requests.
- `MEM0_FORGET_MAX_DELETIONS`: max memory IDs deleted for a single forget request.
- `MEM0_FORGET_MIN_SCORE`: minimum score used when collecting delete candidates.
- `MEM0_FORGET_PASSES`: number of cleanup passes for forget requests (helps with async write races).
- `MEM0_FORGET_SETTLE_MS`: wait time between forget cleanup passes.
- `MEM0_AGENT_ID`, `MEM0_RUN_ID`, `MEM0_APP_ID`, `MEM0_ORG_ID`, `MEM0_PROJECT_ID`: default scope values.
- `MEM0_USE_CONVERSATION_AS_RUN_ID`: map LibreChat conversation ID to `run_id`.
- `MEM0_CUSTOM_FACT_EXTRACTION_PROMPT`: override extraction prompt (safety layer appends JSON schema hints).
- `MEM0_CUSTOM_UPDATE_MEMORY_PROMPT`: override update prompt (safety layer appends JSON action schema hints).
- `MEM0_INJECT_ROLE`: usually `system`.
- `OPENMEMORY_USER_ID`: when set, gateway uses this fixed user for all memory operations.
- `OPENMEMORY_APP`: app label stored in OpenMemory (`librechat` by default).
- `AVAILABLE_MODELS`: comma-separated list for `/v1/models`.

OpenMemory (`openmemory.env`):

- `OPENAI_API_KEY`: your OpenRouter key (used for embeddings and fact extraction).
- `OPENAI_BASE_URL`: `https://openrouter.ai/api/v1`.
- `QDRANT_HOST`, `QDRANT_PORT`: Qdrant connection.

## Notes

- Streaming is supported. When `MEM0_STORE_MODE=both`, the gateway will try to
  reconstruct assistant output from the stream before writing to Mem0.
- Multimodal memory write paths preserve OpenAI-style content arrays (`text` + `image_url`);
  unsupported image MIME types and oversized base64 payloads are filtered out before write.
- In `mem0_compat` mode, if vision/image parsing fails upstream (for example provider returns `Invalid image data`),
  the API retries with image parts removed so text facts can still be persisted.
- Forget commands such as "forget everything about pizza" trigger targeted memory deletion by ID before generating a reply.
- Memory prompt injection prioritizes newer facts when older memories conflict.
- `/v1/responses` is supported. If your upstream does not implement it, keep
  `useResponsesApi` disabled in LibreChat.
- Default port is `8001` to avoid clashing with Mem0 OSS (default `8000`).
- Optional graph backend profile is available in compose via `--profile graph`.
