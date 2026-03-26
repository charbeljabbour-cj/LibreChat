# Azure Deployment Guide — Mem0 Gateway for LibreChat

This guide walks you through deploying the mem0 gateway stack on Azure so that
your existing LibreChat instance gains semantic memory. Nothing in LibreChat
itself is modified — you add four services and a custom endpoint definition.

## Architecture

```
LibreChat
    |  (custom endpoint)
    v
mem0-gateway:8001  -------->  OpenRouter (or any OpenAI-compatible API)
    |
    +-- search/store memories
    |
    v
openmemory-api:8765
    |
    +-------+-------+
    |               |
    v               v
Qdrant:6333      Neo4j:7687
(vectors)        (graph)
```

Four services total (plus LibreChat itself):

| Service | Purpose |
|---|---|
| **mem0-gateway** | OpenAI-compatible proxy — intercepts chat requests, injects memories, forwards to upstream LLM |
| **openmemory-api** | Memory engine — stores, searches, and extracts facts using vector + graph backends |
| **Qdrant** | Vector database — stores memory embeddings |
| **Neo4j** | Graph database — stores knowledge relationships between facts |

## Prerequisites

- An Azure VM with Docker and Docker Compose **or** an AKS / Azure Container Apps environment
- An existing LibreChat deployment (Docker Compose or Kubernetes)
- An Azure Container Registry (ACR) if you need to push custom images
- An [OpenRouter](https://openrouter.ai) API key (used for both chat completions and embeddings/fact extraction)
- Git installed on your build machine

---

## 1. Get the code

Clone the repository that contains the gateway:

```bash
git clone https://github.com/LibreChat-AI/LibreChat.git
cd LibreChat/mem0-gateway
```

> **Tip:** If you only need the gateway directory, use a sparse checkout:
> ```bash
> git clone --filter=blob:none --sparse https://github.com/LibreChat-AI/LibreChat.git
> cd LibreChat
> git sparse-checkout set mem0-gateway
> ```

### Directory structure — what matters

```
mem0-gateway/
├── src/server.js                          # Gateway application
├── package.json / package-lock.json       # Node.js dependencies (used to build the gateway image)
├── config/.env.example                    # Gateway env config template
├── compose/
│   ├── docker-compose.yml                 # Reference compose file (all 4 services)
│   └── openmemory.env.example             # OpenMemory env config template
├── vendor/mem0/openmemory/api/            # OpenMemory API source + Dockerfile
│   └── Dockerfile
└── docs/
    └── AZURE_DEPLOYMENT.md                # This file
```

---

## 2. Build the Docker images

Two images need to be built from source. The other two (Qdrant, Neo4j) are
pulled from public registries.

### mem0-gateway image

Create a `Dockerfile` in the `mem0-gateway/` directory (the repository uses an
inline build in the compose file — this is the extracted standalone version):

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
EXPOSE 8001
CMD ["node", "src/server.js"]
```

Build and push to ACR:

```bash
cd mem0-gateway

# Build
docker build -t mem0-gateway:latest .

# Tag for ACR (replace <acr-name> with your registry name)
docker tag mem0-gateway:latest <acr-name>.azurecr.io/mem0-gateway:latest

# Push
az acr login --name <acr-name>
docker push <acr-name>.azurecr.io/mem0-gateway:latest
```

### openmemory-api image

The Dockerfile already exists at `vendor/mem0/openmemory/api/Dockerfile`.

```bash
cd mem0-gateway/vendor/mem0/openmemory/api

# Build
docker build -t openmemory-api:latest .

# Tag and push to ACR
docker tag openmemory-api:latest <acr-name>.azurecr.io/openmemory-api:latest
docker push <acr-name>.azurecr.io/openmemory-api:latest
```

### Pre-built images (no build needed)

| Service | Image |
|---|---|
| Qdrant | `qdrant/qdrant` (Docker Hub) |
| Neo4j | `neo4j:5` (Docker Hub) |

---

## 3. Option A — Docker Compose on Azure VM

If you run LibreChat with Docker Compose on a VM, the simplest approach is to
run the memory stack as a second compose project on the same Docker network.

### Create a shared network

If your LibreChat compose doesn't already use a named external network, create
one:

```bash
docker network create librechat-net
```

Then add this to your existing LibreChat `docker-compose.yml`:

```yaml
networks:
  default:
    external: true
    name: librechat-net
```

### Memory stack compose file

Create `mem0-compose.yml` (or add these services to your existing compose):

```yaml
services:
  mem0-store:
    image: qdrant/qdrant
    restart: unless-stopped
    volumes:
      - mem0_storage:/qdrant/storage

  neo4j:
    image: neo4j:5
    restart: unless-stopped
    environment:
      NEO4J_AUTH: neo4j/${NEO4J_PASSWORD:-change-me}
      NEO4J_apoc_export_file_enabled: "true"
      NEO4J_apoc_import_file_enabled: "true"
      NEO4J_dbms_security_procedures_unrestricted: apoc.*
    volumes:
      - neo4j_data:/data

  openmemory-api:
    image: <acr-name>.azurecr.io/openmemory-api:latest
    restart: unless-stopped
    env_file:
      - ./openmemory.env
    environment:
      DATABASE_URL: sqlite:////data/openmemory.db
    volumes:
      - openmemory_db:/data
    depends_on:
      - mem0-store
      - neo4j

  mem0-gateway:
    image: <acr-name>.azurecr.io/mem0-gateway:latest
    restart: unless-stopped
    env_file:
      - ./gateway.env
    depends_on:
      - openmemory-api

volumes:
  mem0_storage:
  openmemory_db:
  neo4j_data:

networks:
  default:
    external: true
    name: librechat-net
```

> **Note:** Ports are deliberately **not** exposed. All services communicate over
> the internal Docker network. LibreChat reaches the gateway at
> `http://mem0-gateway:8001`. If you need to inspect Neo4j or Qdrant during
> debugging, temporarily add port mappings.

### Create the env files

You need two env files next to your compose file. See sections 4 and 5 below
for the full contents.

```bash
# Gateway config
cp mem0-gateway/config/.env.example ./gateway.env
# Edit gateway.env — see section 4

# OpenMemory config
cp mem0-gateway/compose/openmemory.env.example ./openmemory.env
# Edit openmemory.env — see section 5
```

### Start the stack

```bash
docker compose -f mem0-compose.yml up -d
```

---

## 4. Option B — Azure Container Apps / AKS

For Container Apps or AKS, translate the compose services into container
deployments. Key considerations:

- **Internal networking:** All four services must be able to reach each other by
  service name. On AKS, deploy them in the same namespace with Kubernetes
  Services. On Container Apps, use the same environment and internal ingress.
- **Persistent volumes:**
  - Qdrant → mount Azure Disk at `/qdrant/storage`
  - OpenMemory → mount Azure Disk at `/data` (SQLite database)
  - Neo4j → mount Azure Disk at `/data`
- **Secrets:** Use Azure Key Vault references instead of env files (see
  section 9).
- **Probes:** Add health checks — the gateway exposes `GET /health` returning
  `{"ok":true}`.

A minimal AKS deployment would include four Deployments + four Services
(ClusterIP). Only LibreChat needs to reach `mem0-gateway` — everything else is
internal.

---

## 5. Configure the gateway (gateway.env)

This is the environment file for the `mem0-gateway` container. Create it from
the template and set your values:

```env
# ─── Server ──────────────────────────────────────────────────────────
PORT=8001
BODY_LIMIT=25mb

# ─── Gateway auth (LibreChat -> gateway) ─────────────────────────────
# Generate a strong random key. LibreChat will send this as a Bearer token.
GATEWAY_API_KEY=<generate-a-strong-key>

# ─── Upstream model provider (gateway -> OpenRouter) ─────────────────
UPSTREAM_BASE_URL=https://openrouter.ai/api/v1
UPSTREAM_API_KEY=<your-openrouter-key>
# OpenRouter expects these headers for attribution
UPSTREAM_HEADERS={"HTTP-Referer":"https://your-domain.com","X-Title":"LibreChat"}

# ─── Memory backend ─────────────────────────────────────────────────
MEM0_ENABLED=true
MEM0_MODE=mem0_compat
MEM0_API_BASE=http://openmemory-api:8765
MEM0_API_KEY=
MEM0_API_FLAVOR=mem0_v2

# ─── Search tuning ──────────────────────────────────────────────────
MEM0_SEARCH_TOP_K=6
MEM0_MAX_MEMORIES=6
MEM0_THRESHOLD=0.0
MEM0_SEARCH_THRESHOLD=0.0
MEM0_SEARCH_RERANK=true

# ─── Graph memory (Neo4j) ───────────────────────────────────────────
MEM0_ENABLE_GRAPH=true
MEM0_INCLUDE_RELATIONS_IN_PROMPT=true

# ─── Memory storage behavior ────────────────────────────────────────
# user_only = store user messages; both = store user + assistant messages
MEM0_STORE_MODE=user_only
MEM0_STORE_STRATEGY=all
MEM0_ASYNC_MODE=true
MEM0_OUTPUT_FORMAT=v1.1
MEM0_VERSION=v1.1

# ─── Forget handling ────────────────────────────────────────────────
# Allows users to say "forget everything about X" to delete memories
MEM0_FORGET_ENABLED=true
MEM0_FORGET_MAX_DELETIONS=20
MEM0_FORGET_MIN_SCORE=0
MEM0_FORGET_PASSES=2
MEM0_FORGET_SETTLE_MS=1200

# ─── Multimodal ─────────────────────────────────────────────────────
MEM0_MULTIMODAL_ENABLED=true
MEM0_MAX_IMAGE_BYTES=20971520
MEM0_ALLOWED_IMAGE_MIME_TYPES=image/jpeg,image/jpg,image/png,image/webp,image/gif

# ─── Retry settings ─────────────────────────────────────────────────
MEM0_ADD_RETRIES=2
MEM0_ADD_RETRY_DELAY_MS=500

# ─── App identity ───────────────────────────────────────────────────
# Leave OPENMEMORY_USER_ID empty to use per-request X-User-Id from LibreChat
OPENMEMORY_USER_ID=
OPENMEMORY_APP=librechat
OPENMEMORY_APP_INCLUDE_USER_ID=true
OPENMEMORY_INFER=true

# ─── Timeouts ────────────────────────────────────────────────────────
UPSTREAM_TIMEOUT_MS=120000
MEM0_TIMEOUT_MS=30000

# ─── Logging ─────────────────────────────────────────────────────────
LOG_LEVEL=info
```

### Key variables explained

| Variable | What it does |
|---|---|
| `GATEWAY_API_KEY` | Protects the gateway — LibreChat must send this as a Bearer token |
| `UPSTREAM_BASE_URL` | Where to forward chat requests (e.g. OpenRouter, Azure OpenAI) |
| `UPSTREAM_API_KEY` | API key for the upstream provider |
| `MEM0_API_BASE` | Internal URL of the openmemory-api service |
| `MEM0_STORE_MODE` | `user_only` stores only user messages; `both` also stores assistant replies |
| `MEM0_ENABLE_GRAPH` | Enables knowledge-graph relationships via Neo4j |
| `MEM0_FORGET_ENABLED` | Lets users say "forget X" to delete specific memories |

---

## 6. Configure OpenMemory (openmemory.env)

This is the environment file for the `openmemory-api` container:

```env
USER=default_user

# ─── LLM provider (for embeddings and fact extraction) ───────────────
# OpenMemory uses this key to call the LLM for extracting facts from
# conversations and generating embeddings. It calls OpenRouter the same
# way the gateway does.
OPENAI_API_KEY=<your-openrouter-key>
OPENAI_BASE_URL=https://openrouter.ai/api/v1

# ─── Vector store (Qdrant) ──────────────────────────────────────────
QDRANT_HOST=mem0-store
QDRANT_PORT=6333

# ─── Memory engine version ──────────────────────────────────────────
MEM0_VERSION=v1.1

# ─── Graph store (Neo4j) ────────────────────────────────────────────
# Connects OpenMemory to the Neo4j service for knowledge-graph
# relationships between memories (e.g. "User works at ESAB",
# "ESAB is a welding company").
# IMPORTANT: The password here must match the NEO4J_AUTH value.
MEM0_GRAPH_STORE_JSON={"provider":"neo4j","config":{"url":"neo4j://neo4j:7687","username":"neo4j","password":"<neo4j-password>"}}
```

### Notes

- `OPENAI_API_KEY` is **not** an OpenAI key — it's your OpenRouter key. The
  variable name is required by the OpenMemory API's OpenAI-compatible client.
- `QDRANT_HOST` must match the Qdrant service name in your compose/deployment
  (`mem0-store` in the reference compose).
- The `neo4j://neo4j:7687` URL uses the Neo4j service name. On AKS, this would
  be the Kubernetes Service name.

---

## 7. Configure Neo4j

Set the Neo4j password via the `NEO4J_AUTH` environment variable on the Neo4j
container:

```env
NEO4J_AUTH=neo4j/<neo4j-password>
```

The password must match the `password` field in `MEM0_GRAPH_STORE_JSON` from
`openmemory.env`. If they don't match, OpenMemory won't be able to store or
query graph relationships.

Additional Neo4j environment variables set in the compose:

```env
NEO4J_apoc_export_file_enabled=true
NEO4J_apoc_import_file_enabled=true
NEO4J_dbms_security_procedures_unrestricted=apoc.*
```

These enable the APOC plugin, which OpenMemory uses for graph operations.

---

## 8. Wire into LibreChat

### Add the custom endpoint to librechat.yaml

In your LibreChat `librechat.yaml`, add a custom endpoint that points to the
gateway:

```yaml
endpoints:
  custom:
    - name: "Memory Chat"
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

### Add the gateway key to LibreChat's .env

In LibreChat's `.env` file, add:

```env
MEM0_GATEWAY_API_KEY=<same-key-as-GATEWAY_API_KEY-in-gateway.env>
```

This must match the `GATEWAY_API_KEY` you set in the gateway env file.

### Header variables explained

| Header | Template variable | What it does |
|---|---|---|
| `X-User-Id` | `{{LIBRECHAT_USER_ID}}` | LibreChat substitutes the logged-in user's ID. The gateway uses this to scope memories per user. |
| `X-Conversation-Id` | `{{LIBRECHAT_BODY_CONVERSATIONID}}` | LibreChat substitutes the current conversation ID. Used for metadata on stored memories. |

### Why `memory: disabled: true`?

This disables LibreChat's built-in memory feature. The mem0 gateway provides its
own memory layer — running both would be redundant and potentially confusing.

---

## 9. Start and verify

### Start the services

```bash
# If using a separate compose file:
docker compose -f mem0-compose.yml up -d

# Check that all containers are running:
docker compose -f mem0-compose.yml ps
```

Wait about 30 seconds for Neo4j and Qdrant to fully initialize.

### Verify the gateway is healthy

```bash
curl http://mem0-gateway:8001/health
# Expected: {"ok":true}
```

(From outside the Docker network, use `localhost:8001` if you've temporarily
exposed the port.)

### Test memory end-to-end

1. Open LibreChat and select the **"Memory Chat"** endpoint.
2. In a new conversation, send: **"Remember that I work at ESAB"**
3. Start a **new conversation** (same endpoint) and ask: **"Where do I work?"**
4. The gateway should retrieve the stored memory and the model should answer
   with "ESAB" (or similar).

### Inspect the graph database

If you temporarily expose Neo4j's browser port (`7474`), you can inspect the
knowledge graph:

```bash
# Temporarily expose Neo4j browser (for debugging only):
# Add "ports: ['7474:7474']" to the neo4j service, then:
docker compose -f mem0-compose.yml up -d neo4j
```

Open `http://<vm-ip>:7474` in your browser. Log in with `neo4j` / your
password. Run a Cypher query to see stored relationships:

```cypher
MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 25
```

> **Remove the port mapping** after debugging. Neo4j should not be publicly
> accessible in production.

### Check gateway logs

```bash
docker compose -f mem0-compose.yml logs mem0-gateway --tail 50
```

Look for:
- `Mem0 gateway listening on port 8001` — gateway started
- `[info]` lines about memory search/add — memory operations happening

---

## 10. Production hardening

### Secrets management

Store all sensitive values in **Azure Key Vault** instead of `.env` files:

| Secret | Used by |
|---|---|
| `GATEWAY_API_KEY` | mem0-gateway |
| `UPSTREAM_API_KEY` (OpenRouter) | mem0-gateway |
| `OPENAI_API_KEY` (OpenRouter) | openmemory-api |
| `NEO4J_AUTH` password | neo4j, openmemory-api (via `MEM0_GRAPH_STORE_JSON`) |
| `MEM0_GATEWAY_API_KEY` | LibreChat |

On AKS, use the [Secrets Store CSI Driver](https://learn.microsoft.com/en-us/azure/aks/csi-secrets-store-driver)
to mount Key Vault secrets as environment variables. On Container Apps, use
[Key Vault references](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets).

### Persistent volumes

Attach Azure Disk or Azure Files volumes to prevent data loss on restarts:

| Container | Mount path | Purpose | Recommended size |
|---|---|---|---|
| Qdrant | `/qdrant/storage` | Vector embeddings | 10–50 GB |
| OpenMemory | `/data` | SQLite database (`openmemory.db`) | 1–5 GB |
| Neo4j | `/data` | Graph database | 10–50 GB |

### Backups

- **Qdrant:** Back up the `/qdrant/storage` volume (snapshot the Azure Disk).
- **OpenMemory:** Back up `/data/openmemory.db` inside the volume. This is a
  SQLite file — you can copy it while the service is running.
- **Neo4j:** Back up the `/data` volume or use `neo4j-admin database dump`
  inside the container.

### Networking

All four memory services should communicate over an **internal network only**.
Do not expose these ports publicly:

| Port | Service | Reason |
|---|---|---|
| 8001 | mem0-gateway | Only LibreChat needs to reach it |
| 8765 | openmemory-api | Only the gateway needs to reach it |
| 6333 | Qdrant | Only openmemory-api needs to reach it |
| 7474, 7687 | Neo4j | Only openmemory-api needs to reach it |

On AKS, use `ClusterIP` services (not `LoadBalancer`). On Container Apps, use
internal ingress.

### Monitoring and logging

- Set `LOG_LEVEL=info` on the gateway (or `debug` for troubleshooting).
- Forward container logs to Azure Monitor / Log Analytics.
- Set up alerts for container restarts and high error rates.
- Monitor Qdrant storage usage — vector databases grow as memories accumulate.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Gateway returns 401 | `GATEWAY_API_KEY` doesn't match `MEM0_GATEWAY_API_KEY` in LibreChat | Ensure both values are identical |
| "Memory Chat" endpoint doesn't appear in LibreChat | `librechat.yaml` not loaded or syntax error | Check LibreChat logs, validate YAML |
| Memories not being stored | `MEM0_ENABLED=false` or openmemory-api unreachable | Check gateway logs for `Mem0 add failed` |
| Graph relationships not appearing | Neo4j password mismatch or `MEM0_ENABLE_GRAPH=false` | Ensure `MEM0_GRAPH_STORE_JSON` password matches `NEO4J_AUTH` |
| Gateway timeout errors | `UPSTREAM_TIMEOUT_MS` too low for the model | Increase to `180000` or higher |
| OpenMemory returns errors about embeddings | OpenRouter key invalid or `OPENAI_BASE_URL` wrong | Verify `OPENAI_API_KEY` and `OPENAI_BASE_URL` in `openmemory.env` |
