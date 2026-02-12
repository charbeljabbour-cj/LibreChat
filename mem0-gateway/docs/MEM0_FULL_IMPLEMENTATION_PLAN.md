# Mem0 Full-Feature Implementation Plan

## Goal

Implement a production-ready, self-hosted Mem0 setup that covers the full documented open-source feature set and integrates cleanly with LibreChat through the existing gateway pattern.

Primary reference: https://docs.mem0.ai/open-source/overview

## Scope

This plan targets parity with documented Mem0 OSS capabilities, including:

- OpenAI-compatible chat integration
- REST API parity for memory operations
- Advanced retrieval and filtering
- Graph memory support
- Reranker-enhanced search
- Async memory behavior
- Multimodal memory ingestion
- Custom fact extraction and update prompts
- Operational hardening, observability, and validation

## Current Baseline (As-Is)

- Running stack: `mem0-store` (Qdrant), OpenMemory API, OpenMemory UI, `mem0-gateway`
- LibreChat integration works through gateway OpenAI-compatible routes
- Current gateway reads/writes OpenMemory `/api/v1/memories/` endpoints
- Basic memory add/search and prompt injection are functional

Known limitation: current implementation is a working integration, but not full Mem0 OSS docs parity.

## Gap Summary (Docs vs Current)

1. API contract mismatch
   - Current path: OpenMemory `/api/v1/*`
   - Target parity: Mem0 documented `/v1/*` and `/v2/*` operations and semantics
2. Advanced retrieval incomplete
   - Missing full v2 filter grammar and advanced retrieval toggles
3. Graph memory not wired end-to-end
4. Reranker not wired end-to-end
5. Multimodal add path not implemented in gateway pipeline
6. Custom prompts only partially covered
   - Need first-class support for both fact extraction and update prompts
7. Scope fields incomplete in gateway pass-through
   - `agent_id`, `run_id`, `app_id`, `org_id`, `project_id` and related controls
8. Operational hardening incomplete
   - Auth/TLS posture, structured observability, complete test matrix

## Architecture Target

### Runtime Components

- LibreChat
- Mem0 Gateway (OpenAI-compatible facade)
- Mem0 API Server (contract source of truth)
- Vector DB (Qdrant by default, configurable)
- Optional Graph DB (Neo4j/Memgraph/Neptune/Kuzu)
- Optional Reranker provider (Cohere/SentenceTransformer/HuggingFace/LLM)
- OpenMemory UI or equivalent admin UX (optional but recommended)

### Integration Rules

- Gateway remains the only endpoint LibreChat uses for model traffic
- Memory operations are delegated to backend APIs using documented Mem0-compatible payloads
- User isolation remains strict by scoped identifiers and filters

## Implementation Phases

## Phase 0 - Baseline Lock and Safety

Objective: freeze current behavior so upgrades are measurable and reversible.

Tasks:

- Capture current compose, env, and endpoint behavior snapshots
- Create regression fixtures for current add/search/update/delete flows
- Add rollback notes for stack version and env changes

Exit criteria:

- Reproducible baseline runbook exists
- Regression fixture suite runs locally

## Phase 1 - API Contract Parity Foundation

Objective: align memory backend interaction model to Mem0 docs contract.

Tasks:

- Introduce a backend adapter layer in gateway (`provider = mem0_rest`)
- Implement adapters for:
  - `POST /v1/memories/` (add)
  - `PUT /v1/memories/{id}/` (update)
  - `DELETE /v1/memories/{id}/` (delete)
  - `POST /v2/memories/search/` (search)
  - `POST /v2/memories/` (get/list)
- Normalize response handling for both legacy and v2 payload shapes

Exit criteria:

- Gateway can run fully on documented Mem0 contract without fallback paths
- CRUD and retrieval smoke tests pass

## Phase 2 - Full Scope and Payload Support

Objective: ensure all documented identifiers and controls are supported end-to-end.

Tasks:

- Pass through and validate: `user_id`, `agent_id`, `run_id`, `app_id`, `org_id`, `project_id`
- Support advanced fields in add path:
  - `metadata`, `infer`, `async_mode`, `output_format`, `custom_categories`, `custom_instructions`, `immutable`, `timestamp`, `expiration_date`, `version`
- Support retrieval knobs:
  - `top_k`, `limit`, `threshold`, `rerank`, `keyword_search`, `filter_memories`, `fields`

Exit criteria:

- Scope isolation tests pass for all ID combinations
- Payload conformance validated against docs examples

## Phase 3 - Advanced Retrieval and Filtering

Objective: implement full v2 filter grammar and robust retrieval behavior.

Tasks:

- Add full filter DSL support in gateway builder:
  - logical operators: `AND`, `OR`, `NOT`
  - comparison operators: `in`, `gte`, `lte`, `gt`, `lt`, `ne`, `contains`, `icontains`, `*`
- Validate/sanitize filters before backend calls
- Add fallback policy for unsupported operators/provider limits

Exit criteria:

- Complex filter integration tests pass
- No silent filter drops without explicit logs/metrics

## Phase 4 - Graph Memory Capability

Objective: support relationship-aware recall aligned to docs.

Tasks:

- Add graph store configuration and compose profile(s)
- Enable `enable_graph` semantics on add/search paths
- Include relation-aware context in gateway memory injection strategy
- Add graph health checks and diagnostics

Exit criteria:

- Entity/relation creation and retrieval verified
- Graph-off fallback path verified

## Phase 5 - Reranker-Enhanced Search

Objective: add reranker-backed ranking controls and provider support.

Tasks:

- Expose reranker config in env/config endpoints
- Add per-request rerank toggle and defaults
- Add safety fallback to vector-only retrieval on reranker failures
- Measure latency and quality deltas

Exit criteria:

- Rerank on/off tests pass
- Fallbacks are deterministic and logged

## Phase 6 - Multimodal + Async Behavior

Objective: support image-aware memory ingestion and async-safe operation.

Tasks:

- Preserve structured message parts (`text`, `image_url`, base64 data URLs)
- Add size/format guardrails for image inputs
- Honor async ingestion controls and write ordering guarantees
- Add retry/backoff with bounded timeouts

Exit criteria:

- Multimodal ingestion tests pass
- Async race and retry tests pass

## Phase 7 - Custom Prompting and Memory Policies

Objective: support both custom extraction and custom update prompt workflows.

Tasks:

- Add first-class config surfaces for:
  - custom fact extraction prompt
  - custom update memory prompt
- Version prompt templates and support per-project overrides
- Add validation fixtures for ADD/UPDATE/DELETE/NONE behavior

Exit criteria:

- Prompt behavior is deterministic across test fixtures
- Contradiction handling quality meets acceptance targets

## Phase 8 - Security, Observability, and Production Hardening

Objective: make the stack secure and operable in production.

Tasks:

- Enforce API auth policy across gateway and memory backend
- Add TLS/reverse proxy guidance and sample configs
- Add structured logs, correlation IDs, and metrics
- Add backup/restore and disaster recovery runbook
- Add capacity and SLO guidance

Exit criteria:

- Security checklist signed off
- Operability dashboard and runbooks available

## Validation Matrix (Definition of Done)

All must pass before claiming full-feature parity.

- API conformance
  - Add/search/get/update/delete against documented request/response shapes
- Retrieval quality
  - v2 filters, rerank, thresholds, keyword modes
- Graph
  - relation creation and retrieval correctness
- Multimodal
  - URL/base64 image ingest and retrieval behavior
- Async
  - concurrent add/search stability and ordering
- Scope isolation
  - user/agent/run/app/org/project boundaries
- Prompt controls
  - custom extraction and update behavior under fixtures
- Reliability
  - fallback behavior when reranker/graph/backends are degraded

## Proposed Deliverables

1. Updated gateway implementation with provider adapter and full payload support
2. Updated compose profiles for optional graph/reranker components
3. Unified env templates and docs with parity examples
4. Integration test suite and parity checklist
5. Operational runbook (security, deployment, backup/restore, rollback)

## Risks and Mitigations

- Backend contract drift
  - Mitigation: adapter isolation and schema fixtures
- Latency increase with reranker/graph
  - Mitigation: configurable toggles, thresholds, and fallbacks
- Scope leakage across tenants
  - Mitigation: strict filter validation and isolation tests
- Prompt-driven non-determinism
  - Mitigation: fixture-based evaluations and prompt versioning

## Rollout Strategy

- Stage 1: shadow mode (collect metrics, no user-facing behavior changes)
- Stage 2: opt-in by endpoint/model/user cohort
- Stage 3: default-on with monitored fallbacks
- Stage 4: remove legacy paths after stabilization

## Success Criteria

- Full documented Mem0 OSS feature coverage implemented and validated
- No regression in existing LibreChat memory experience
- Stable production operation with clear observability and rollback paths
