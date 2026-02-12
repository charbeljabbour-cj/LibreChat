const fs = require('fs');
const path = require('path');
const express = require('express');

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const app = express();
const port = Number(process.env.PORT || 8001);

app.use(express.json({ limit: process.env.BODY_LIMIT || '25mb' }));

const config = {
  gatewayApiKey: process.env.GATEWAY_API_KEY || '',
  upstreamBaseUrl: process.env.UPSTREAM_BASE_URL || '',
  upstreamApiKey: process.env.UPSTREAM_API_KEY || '',
  upstreamHeaders: process.env.UPSTREAM_HEADERS || '',
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 120000),
  mem0Enabled: process.env.MEM0_ENABLED !== 'false',
  mem0Mode: process.env.MEM0_MODE || 'oss',
  mem0ApiBase: process.env.MEM0_API_BASE || 'http://localhost:8000',
  mem0ApiKey: process.env.MEM0_API_KEY || '',
  mem0TimeoutMs: Number(process.env.MEM0_TIMEOUT_MS || 30000),
  mem0SearchTopK: Number(process.env.MEM0_SEARCH_TOP_K || 6),
  mem0MaxMemories: Number(process.env.MEM0_MAX_MEMORIES || 6),
  mem0Threshold: Number(process.env.MEM0_THRESHOLD || 0.3),
  mem0StoreMode: process.env.MEM0_STORE_MODE || 'user_only',
  mem0StoreStrategy: process.env.MEM0_STORE_STRATEGY || 'selective',
  mem0InjectRole: process.env.MEM0_INJECT_ROLE || 'system',
  mem0ApiFlavor: process.env.MEM0_API_FLAVOR || 'openmemory_legacy',
  mem0DefaultAgentId: process.env.MEM0_AGENT_ID || '',
  mem0DefaultRunId: process.env.MEM0_RUN_ID || '',
  mem0DefaultAppId: process.env.MEM0_APP_ID || '',
  mem0DefaultOrgId: process.env.MEM0_ORG_ID || '',
  mem0DefaultProjectId: process.env.MEM0_PROJECT_ID || '',
  mem0UseConversationAsRunId: process.env.MEM0_USE_CONVERSATION_AS_RUN_ID === 'true',
  mem0SearchRerank: process.env.MEM0_SEARCH_RERANK === 'true',
  mem0KeywordSearch: process.env.MEM0_KEYWORD_SEARCH === 'true',
  mem0FilterMemories: process.env.MEM0_FILTER_MEMORIES === 'true',
  mem0SearchFields: parseJsonEnv(process.env.MEM0_SEARCH_FIELDS || '', []),
  mem0SearchFilters: parseJsonEnv(process.env.MEM0_SEARCH_FILTERS || '', {}),
  mem0SearchThreshold: Number(process.env.MEM0_SEARCH_THRESHOLD || process.env.MEM0_THRESHOLD || 0.3),
  mem0EnableGraph: process.env.MEM0_ENABLE_GRAPH === 'true',
  mem0IncludeRelationsInPrompt: process.env.MEM0_INCLUDE_RELATIONS_IN_PROMPT !== 'false',
  mem0StoreAsyncMode: process.env.MEM0_ASYNC_MODE !== 'false',
  mem0OutputFormat: process.env.MEM0_OUTPUT_FORMAT || 'v1.1',
  mem0Version: process.env.MEM0_VERSION || 'v1.1',
  mem0MemoryType: process.env.MEM0_MEMORY_TYPE || '',
  mem0Prompt: process.env.MEM0_PROMPT || '',
  mem0CustomCategories: parseJsonEnv(process.env.MEM0_CUSTOM_CATEGORIES || '', null),
  mem0Immutable: process.env.MEM0_IMMUTABLE === 'true',
  mem0ExpirationDate: process.env.MEM0_EXPIRATION_DATE || '',
  mem0TimestampMode: process.env.MEM0_TIMESTAMP_MODE || 'none',
  mem0MultimodalEnabled: process.env.MEM0_MULTIMODAL_ENABLED !== 'false',
  mem0MaxImageBytes: Number(process.env.MEM0_MAX_IMAGE_BYTES || 20 * 1024 * 1024),
  mem0AllowedImageMimeTypes: (process.env.MEM0_ALLOWED_IMAGE_MIME_TYPES || 'image/jpeg,image/jpg,image/png,image/webp,image/gif')
    .split(',')
    .map((mimeType) => mimeType.trim().toLowerCase())
    .filter(Boolean),
  mem0AddRetries: Math.max(0, Number(process.env.MEM0_ADD_RETRIES || 2)),
  mem0AddRetryDelayMs: Math.max(0, Number(process.env.MEM0_ADD_RETRY_DELAY_MS || 500)),
  mem0CustomFactExtractionPrompt: process.env.MEM0_CUSTOM_FACT_EXTRACTION_PROMPT || '',
  mem0CustomUpdatePrompt: process.env.MEM0_CUSTOM_UPDATE_MEMORY_PROMPT || '',
  openmemoryUserId: process.env.OPENMEMORY_USER_ID || '',
  openmemoryApp: process.env.OPENMEMORY_APP || 'librechat',
  openmemoryAppIncludeUserId: process.env.OPENMEMORY_APP_INCLUDE_USER_ID === 'true',
  openmemoryInfer: process.env.OPENMEMORY_INFER === 'true',
  logLevel: process.env.LOG_LEVEL || 'info',
};

const logLevels = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLogLevel = logLevels[config.logLevel] ?? logLevels.info;
const log = {
  debug: (...args) => currentLogLevel <= logLevels.debug && console.log('[debug]', ...args),
  info: (...args) => currentLogLevel <= logLevels.info && console.log('[info]', ...args),
  warn: (...args) => currentLogLevel <= logLevels.warn && console.warn('[warn]', ...args),
  error: (...args) => console.error('[error]', ...args),
};

const pendingMemoryWritesByScope = new Map();

function getScopeQueueKey(scope) {
  const user = scope?.userId || '-';
  const agent = scope?.agentId || '-';
  const run = scope?.runId || '-';
  return `${user}:${agent}:${run}`;
}

function enqueueMemoryWrite(scope, writeTask) {
  const queueKey = getScopeQueueKey(scope);
  const previous = pendingMemoryWritesByScope.get(queueKey) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(writeTask)
    .finally(() => {
      if (pendingMemoryWritesByScope.get(queueKey) === next) {
        pendingMemoryWritesByScope.delete(queueKey);
      }
    });

  pendingMemoryWritesByScope.set(queueKey, next);
  return next;
}

async function waitForPendingMemoryWrite(scope) {
  const queueKey = getScopeQueueKey(scope);
  const pending = pendingMemoryWritesByScope.get(queueKey);
  if (!pending) return;
  try {
    await pending;
  } catch {
    // Ignore queue failures for retrieval flow.
  }
}

function normalizeBaseUrl(value) {
  if (!value) return '';
  return value.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function parseJsonEnv(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    log.warn('Failed to parse JSON env value', error.message);
    return fallback;
  }
}

function parseBooleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function parseNumberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getImageUrlFromPart(part) {
  if (!part || typeof part !== 'object') return '';
  if (typeof part.image_url === 'string') return part.image_url;
  if (typeof part.image_url?.url === 'string') return part.image_url.url;
  if (typeof part.url === 'string' && ['image_url', 'input_image'].includes(part.type)) return part.url;
  return '';
}

function parseDataUrlMeta(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/^data:([^;,]+);base64,/i);
  if (!match) return null;
  return {
    mimeType: match[1].toLowerCase(),
    base64Payload: url.slice(match[0].length),
  };
}

function estimateBase64Bytes(base64Payload) {
  if (typeof base64Payload !== 'string' || base64Payload.length === 0) return 0;
  const sanitized = base64Payload.replace(/\s+/g, '');
  const padding = sanitized.endsWith('==') ? 2 : sanitized.endsWith('=') ? 1 : 0;
  return Math.floor((sanitized.length * 3) / 4) - padding;
}

function isAllowedImageMimeType(mimeType) {
  if (!mimeType) return false;
  return config.mem0AllowedImageMimeTypes.includes(String(mimeType).toLowerCase());
}

function isSupportedRemoteImageUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateImageUrlForMem0(url) {
  const dataUrlMeta = parseDataUrlMeta(url);
  if (dataUrlMeta) {
    if (!isAllowedImageMimeType(dataUrlMeta.mimeType)) {
      log.warn('Skipping image memory part due to unsupported MIME type', dataUrlMeta.mimeType);
      return false;
    }
    const estimatedBytes = estimateBase64Bytes(dataUrlMeta.base64Payload);
    if (estimatedBytes > config.mem0MaxImageBytes) {
      log.warn('Skipping image memory part due to size limit', estimatedBytes);
      return false;
    }
    return true;
  }

  if (!isSupportedRemoteImageUrl(url)) {
    log.warn('Skipping image memory part due to invalid URL format');
    return false;
  }

  return true;
}

function sanitizeMem0ContentPart(part) {
  if (typeof part === 'string') {
    return part.trim() ? part : null;
  }

  if (!part || typeof part !== 'object') {
    return null;
  }

  const imageUrl = getImageUrlFromPart(part);
  if (imageUrl) {
    return validateImageUrlForMem0(imageUrl) ? part : null;
  }

  if (typeof part.text === 'string' && part.text.trim()) {
    return part;
  }

  if (typeof part.content === 'string' && part.content.trim()) {
    return part;
  }

  return null;
}

function sanitizeMessageContentForMem0(content) {
  if (!config.mem0MultimodalEnabled) {
    return typeof content === 'string' ? content : extractTextFromContent(content);
  }

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const sanitizedParts = content.map(sanitizeMem0ContentPart).filter(Boolean);
    return sanitizedParts.length > 0 ? sanitizedParts : '';
  }

  if (content && typeof content === 'object') {
    const sanitizedPart = sanitizeMem0ContentPart(content);
    return sanitizedPart || '';
  }

  return '';
}

function hasImageInContent(content) {
  if (!content) return false;
  if (Array.isArray(content)) {
    return content.some((part) => Boolean(getImageUrlFromPart(part)));
  }
  if (typeof content === 'object') {
    return Boolean(getImageUrlFromPart(content));
  }
  return false;
}

function hasStorableMemoryContent(content) {
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }

  if (Array.isArray(content)) {
    return content.some((part) => Boolean(sanitizeMem0ContentPart(part)));
  }

  if (content && typeof content === 'object') {
    return Boolean(sanitizeMem0ContentPart(content));
  }

  return false;
}

function getMem0RequestOptions(req, body = {}) {
  const mem0Body = body?.mem0 && typeof body.mem0 === 'object' ? body.mem0 : {};

  const parseHeaderNumber = (headerName) => parseNumberValue(getHeader(req, headerName));
  const parseHeaderBoolean = (headerName) => parseBooleanValue(getHeader(req, headerName));

  const bodyTopK = parseNumberValue(mem0Body.top_k);
  const headerTopK = parseHeaderNumber('x-mem0-top-k');
  const topK = Math.max(1, Math.floor(bodyTopK ?? headerTopK ?? config.mem0SearchTopK));

  const bodyThreshold = parseNumberValue(mem0Body.threshold);
  const headerThreshold = parseHeaderNumber('x-mem0-threshold');
  const threshold = bodyThreshold ?? headerThreshold ?? config.mem0SearchThreshold;

  const bodyRerank = parseBooleanValue(mem0Body.rerank);
  const headerRerank = parseHeaderBoolean('x-mem0-rerank');
  const rerank = bodyRerank ?? headerRerank ?? config.mem0SearchRerank;

  const bodyKeywordSearch = parseBooleanValue(mem0Body.keyword_search);
  const headerKeywordSearch = parseHeaderBoolean('x-mem0-keyword-search');
  const keywordSearch = bodyKeywordSearch ?? headerKeywordSearch ?? config.mem0KeywordSearch;

  const bodyFilterMemories = parseBooleanValue(mem0Body.filter_memories);
  const headerFilterMemories = parseHeaderBoolean('x-mem0-filter-memories');
  const filterMemories = bodyFilterMemories ?? headerFilterMemories ?? config.mem0FilterMemories;

  const bodyEnableGraph = parseBooleanValue(mem0Body.enable_graph);
  const headerEnableGraph = parseHeaderBoolean('x-mem0-enable-graph');
  const enableGraph = bodyEnableGraph ?? headerEnableGraph ?? config.mem0EnableGraph;

  const bodyFields = Array.isArray(mem0Body.fields) ? mem0Body.fields : undefined;
  const headerFields = parseJsonHeader(req, 'x-mem0-fields', undefined);
  const fields = Array.isArray(bodyFields)
    ? bodyFields
    : Array.isArray(headerFields)
      ? headerFields
      : config.mem0SearchFields;

  return {
    topK,
    threshold,
    rerank,
    keywordSearch,
    filterMemories,
    enableGraph,
    fields,
  };
}

function getHeader(req, name) {
  return req.headers[name.toLowerCase()];
}

function getUserId(req, body) {
  return (
    getHeader(req, 'x-user-id') ||
    getHeader(req, 'x-userid') ||
    getHeader(req, 'x-librechat-user-id') ||
    body?.user_id ||
    ''
  );
}

function getConversationId(req, body) {
  return (
    getHeader(req, 'x-conversation-id') ||
    getHeader(req, 'x-librechat-conversation-id') ||
    body?.conversation_id ||
    ''
  );
}

function getScopedId(req, body, key, headerNames, envDefault) {
  for (const headerName of headerNames) {
    const value = getHeader(req, headerName);
    if (value) return String(value);
  }

  const bodyValue = body?.[key];
  if (typeof bodyValue === 'string' && bodyValue.trim()) {
    return bodyValue.trim();
  }

  return envDefault || '';
}

function getMemoryScope(req, body, conversationId) {
  const userId = resolveMemoryUserId(getUserId(req, body));
  const agentId = getScopedId(req, body, 'agent_id', ['x-agent-id', 'x-librechat-agent-id'], config.mem0DefaultAgentId);
  let runId = getScopedId(req, body, 'run_id', ['x-run-id', 'x-librechat-run-id'], config.mem0DefaultRunId);
  const appId = getScopedId(req, body, 'app_id', ['x-app-id', 'x-librechat-app-id'], config.mem0DefaultAppId);
  const orgId = getScopedId(req, body, 'org_id', ['x-org-id', 'x-librechat-org-id'], config.mem0DefaultOrgId);
  const projectId = getScopedId(
    req,
    body,
    'project_id',
    ['x-project-id', 'x-librechat-project-id'],
    config.mem0DefaultProjectId,
  );

  if (!runId && config.mem0UseConversationAsRunId && conversationId) {
    runId = conversationId;
  }

  return {
    userId,
    agentId,
    runId,
    appId,
    orgId,
    projectId,
  };
}

function getLastUserMessage(messages) {
  return getLastUserMessageData(messages).text;
}

function resolveMemoryUserId(userId) {
  if (config.mem0Mode === 'openmemory' && config.openmemoryUserId) {
    return config.openmemoryUserId;
  }
  return userId || '';
}

function buildOpenMemoryAppName(userId) {
  if (!config.openmemoryAppIncludeUserId || !userId) {
    return config.openmemoryApp;
  }

  return `${config.openmemoryApp}-${userId}`;
}

function extractTextFromContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (content && typeof content === 'object' && !Array.isArray(content)) {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.input_text === 'string') return content.input_text;
    if (typeof content.content === 'string') return content.content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        if (typeof item?.input_text === 'string') return item.input_text;
        if (typeof item?.content === 'string') return item.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

function getLastUserMessageData(messages) {
  if (!Array.isArray(messages)) return { text: '', content: '' };
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') {
      const text = extractTextFromContent(message.content);
      return {
        text,
        content: message.content,
      };
    }
  }
  return { text: '', content: '' };
}

function getLastUserMessageFromResponsesInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;

  if (Array.isArray(input)) {
    for (let i = input.length - 1; i >= 0; i -= 1) {
      const message = input[i];
      if (message?.role === 'user') {
        return extractTextFromContent(message.content);
      }
    }
  }

  return '';
}

function getLastUserMessageDataFromResponsesInput(input) {
  if (!input) return { text: '', content: '' };
  if (typeof input === 'string') return { text: input, content: input };

  if (Array.isArray(input)) {
    for (let i = input.length - 1; i >= 0; i -= 1) {
      const message = input[i];
      if (message?.role === 'user') {
        return {
          text: extractTextFromContent(message.content),
          content: message.content,
        };
      }
    }
  }

  return { text: '', content: '' };
}

function parseJsonHeader(req, headerName, fallback) {
  const raw = getHeader(req, headerName);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    log.warn(`Failed to parse JSON header ${headerName}`, error.message);
    return fallback;
  }
}

function mergeFiltersWithScope(baseScopeFilters, extraFilters) {
  const scopeFilters = { ...(baseScopeFilters || {}) };
  const ext = extraFilters && typeof extraFilters === 'object' ? extraFilters : {};

  const hasScope = Object.keys(scopeFilters).length > 0;
  const hasExtra = Object.keys(ext).length > 0;

  if (!hasScope) return ext;
  if (!hasExtra) return scopeFilters;

  return {
    AND: [scopeFilters, ext],
  };
}

function getScopeFilters(scope) {
  const filters = {};
  if (scope?.userId) filters.user_id = scope.userId;
  if (scope?.agentId) filters.agent_id = scope.agentId;
  if (scope?.runId) filters.run_id = scope.runId;
  if (scope?.appId) filters.app_id = scope.appId;
  return filters;
}

function injectMemoriesIntoMessages(messages, memoryPrompt) {
  if (!memoryPrompt || !Array.isArray(messages)) {
    return messages;
  }

  if (config.mem0InjectRole !== 'system') {
    return [{ role: config.mem0InjectRole, content: memoryPrompt }, ...messages];
  }

  const systemIndex = messages.findIndex(
    (message) => message?.role === 'system' && typeof message.content === 'string',
  );

  if (systemIndex >= 0) {
    const nextMessages = [...messages];
    const current = nextMessages[systemIndex];
    nextMessages[systemIndex] = {
      ...current,
      content: `${current.content}\n\n${memoryPrompt}`,
    };
    return nextMessages;
  }

  return [{ role: 'system', content: memoryPrompt }, ...messages];
}

function injectMemoriesIntoResponsesMessages(messages, memoryPrompt) {
  if (!memoryPrompt || !Array.isArray(messages)) {
    return messages;
  }

  const role = config.mem0InjectRole || 'system';
  const usesArrayContent = messages.some((message) => Array.isArray(message?.content));
  if (!usesArrayContent) {
    return injectMemoriesIntoMessages(messages, memoryPrompt);
  }

  const roleIndex = messages.findIndex((message) => message?.role === role);
  if (roleIndex >= 0) {
    const nextMessages = [...messages];
    const current = nextMessages[roleIndex];
    const contentArray = Array.isArray(current.content) ? current.content : [];
    nextMessages[roleIndex] = {
      ...current,
      content: [...contentArray, { type: 'input_text', text: memoryPrompt }],
    };
    return nextMessages;
  }

  return [{ role, content: [{ type: 'input_text', text: memoryPrompt }] }, ...messages];
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchMem0WithRetry(url, options, timeoutMs, maxRetries) {
  let attempt = 0;
  let delay = config.mem0AddRetryDelayMs;

  while (true) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      const shouldRetryStatus = response.status === 429 || response.status >= 500;
      if (shouldRetryStatus && attempt < maxRetries) {
        attempt += 1;
        log.warn('Mem0 request retrying after HTTP status', response.status, `attempt=${attempt}`);
        await sleep(delay);
        delay = Math.max(delay * 2, delay + 250);
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error;
      }
      attempt += 1;
      log.warn('Mem0 request retrying after network error', error.message, `attempt=${attempt}`);
      await sleep(delay);
      delay = Math.max(delay * 2, delay + 250);
    }
  }
}

function buildMem0Headers() {
  const headers = { 'Content-Type': 'application/json' };
  if (config.mem0ApiKey) {
    headers.Authorization = `Token ${config.mem0ApiKey}`;
    headers['x-api-key'] = config.mem0ApiKey;
  }
  return headers;
}

function relationToString(relation) {
  if (!relation || typeof relation !== 'object') return '';

  const source = relation.source || relation.source_entity || relation.from || relation.subject || relation.head;
  const target = relation.target || relation.target_entity || relation.to || relation.object || relation.tail;
  const edge =
    relation.relationship || relation.relation || relation.type || relation.predicate || relation.edge || relation.label;

  if (source && target && edge) {
    return `Related context: ${source} -[${edge}]-> ${target}`;
  }
  if (source && target) {
    return `Related context: ${source} -> ${target}`;
  }
  if (typeof relation.memory === 'string' && relation.memory.trim()) {
    return `Related context: ${relation.memory.trim()}`;
  }

  return '';
}

function toMemoryStrings(data, threshold, maxItems) {
  let items = [];

  if (Array.isArray(data)) {
    items = data;
  } else if (Array.isArray(data?.memories)) {
    items = data.memories;
  } else if (Array.isArray(data?.results)) {
    items = data.results;
  } else if (Array.isArray(data?.data)) {
    items = data.data;
  } else if (Array.isArray(data?.items)) {
    items = data.items;
  }

  const memoryLines = items
    .filter((item) => {
      if (typeof item?.score === 'number') {
        return item.score >= threshold;
      }
      return true;
    })
    .map((item) => item?.memory || item?.value || item?.text || item?.content || '')
    .filter(Boolean);

  const relationLines = config.mem0IncludeRelationsInPrompt && Array.isArray(data?.relations)
    ? data.relations.map(relationToString).filter(Boolean)
    : [];

  const deduped = [];
  const seen = new Set();
  for (const line of [...memoryLines, ...relationLines]) {
    const key = String(line).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }

  return deduped.slice(0, maxItems);
}

async function mem0Search({ scope, query, req, body }) {
  if (!config.mem0Enabled || !scope?.userId || !query) return [];

  const apiBase = normalizeBaseUrl(config.mem0ApiBase);
  const requestOptions = getMem0RequestOptions(req, body);
  const requestFilters = parseJsonHeader(req, 'x-mem0-filters', {});
  const bodyFilters = body?.mem0?.filters && typeof body.mem0.filters === 'object' ? body.mem0.filters : {};
  const scopeFilters = getScopeFilters(scope);
  const mergedFilters = mergeFiltersWithScope(
    scopeFilters,
    mergeFiltersWithScope(config.mem0SearchFilters, mergeFiltersWithScope(requestFilters, bodyFilters)),
  );

  try {
    if (config.mem0Mode === 'openmemory' || config.mem0ApiFlavor === 'openmemory_legacy') {
      const buildOpenMemoryUrl = (withQuery = true) => {
        const url = new URL(`${apiBase}/api/v1/memories/`);
        url.searchParams.set('user_id', scope.userId);
        if (withQuery && query) {
          url.searchParams.set('search_query', query);
        }
        url.searchParams.set('page', '1');
        url.searchParams.set('size', String(Math.max(requestOptions.topK, config.mem0MaxMemories)));
        return url.toString();
      };

      const fetchOpenMemoryItems = async (withQuery) => {
        const response = await fetchWithTimeout(
          buildOpenMemoryUrl(withQuery),
          {
            method: 'GET',
            headers: buildMem0Headers(),
          },
          config.mem0TimeoutMs,
        );

        if (!response.ok) {
          log.warn('OpenMemory search failed', response.status, await response.text());
          return [];
        }

        const data = await response.json();
        return Array.isArray(data?.items) ? data.items : [];
      };

      let items = await fetchOpenMemoryItems(true);
      if (items.length === 0) {
        items = await fetchOpenMemoryItems(false);
      }

      return items
        .map((item) => item?.content || item?.text || item?.memory || item?.value || '')
        .filter(Boolean)
        .slice(0, config.mem0MaxMemories);
    }

    if (config.mem0Mode === 'platform' || config.mem0ApiFlavor === 'mem0_v2' || config.mem0Mode === 'mem0_compat') {
      const response = await fetchWithTimeout(
        `${apiBase}/v2/memories/search/`,
        {
          method: 'POST',
          headers: buildMem0Headers(),
          body: JSON.stringify({
            query,
            version: 'v2',
            filters: mergedFilters,
            top_k: requestOptions.topK,
            threshold: requestOptions.threshold,
            rerank: requestOptions.rerank,
            keyword_search: requestOptions.keywordSearch,
            filter_memories: requestOptions.filterMemories,
            enable_graph: requestOptions.enableGraph,
            fields: Array.isArray(requestOptions.fields) && requestOptions.fields.length > 0 ? requestOptions.fields : undefined,
            org_id: scope.orgId || undefined,
            project_id: scope.projectId || undefined,
          }),
        },
        config.mem0TimeoutMs,
      );

      if (!response.ok) {
        log.warn('Mem0 search failed', response.status, await response.text());
        return [];
      }

      const data = await response.json();
      return toMemoryStrings(data, requestOptions.threshold, config.mem0MaxMemories);
    }

    const url = new URL(`${apiBase}/memories/search`);
    url.searchParams.set('user_id', scope.userId);
    url.searchParams.set('query', query);

    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'GET',
        headers: buildMem0Headers(),
      },
      config.mem0TimeoutMs,
    );

    if (!response.ok) {
      log.warn('Mem0 search failed', response.status, await response.text());
      return [];
    }

    const data = await response.json();
    return toMemoryStrings(data, config.mem0Threshold, config.mem0MaxMemories);
  } catch (error) {
    log.warn('Mem0 search error', error.message);
    return [];
  }
}

function extractMemoriesFromResponse(data, threshold) {
  return toMemoryStrings(data, threshold, config.mem0MaxMemories);
}

function normalizeMessagesForMem0(messages) {
  return (messages || [])
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const role = message.role || 'user';
      const content = sanitizeMessageContentForMem0(message.content);
      if (typeof content === 'string') {
        if (!content.trim()) return null;
        return { role, content };
      }
      if (Array.isArray(content) || (content && typeof content === 'object')) {
        if (!hasStorableMemoryContent(content)) return null;
        return { role, content };
      }
      const text = extractTextFromContent(content);
      if (text) return { role, content: text };
      return null;
    })
    .filter(Boolean);
}

function buildMem0WritePayload(scope, messages, metadata, reqBody = {}) {
  const requestEnableGraph = parseBooleanValue(reqBody?.mem0?.enable_graph);

  const payload = {
    user_id: scope.userId || undefined,
    agent_id: scope.agentId || undefined,
    run_id: scope.runId || undefined,
    app_id: scope.appId || undefined,
    org_id: scope.orgId || undefined,
    project_id: scope.projectId || undefined,
    messages,
    metadata,
    infer: config.openmemoryInfer,
    async_mode: config.mem0StoreAsyncMode,
    output_format: config.mem0OutputFormat,
    version: config.mem0Version,
    immutable: config.mem0Immutable,
    expiration_date: config.mem0ExpirationDate || undefined,
    custom_categories: config.mem0CustomCategories || undefined,
    custom_instructions:
      reqBody?.mem0?.custom_instructions || config.mem0CustomFactExtractionPrompt || undefined,
    custom_update_memory_prompt:
      reqBody?.mem0?.custom_update_memory_prompt || config.mem0CustomUpdatePrompt || undefined,
    prompt: reqBody?.mem0?.prompt || config.mem0Prompt || undefined,
    memory_type: reqBody?.mem0?.memory_type || config.mem0MemoryType || undefined,
    enable_graph: requestEnableGraph ?? config.mem0EnableGraph,
  };

  if (config.mem0TimestampMode === 'now') {
    payload.timestamp = Math.floor(Date.now() / 1000);
  }

  return payload;
}

async function mem0Add({ scope, messages, metadata, reqBody }) {
  if (!config.mem0Enabled || !scope?.userId || !Array.isArray(messages) || messages.length === 0) {
    return;
  }

  const apiBase = normalizeBaseUrl(config.mem0ApiBase);
  const normalizedMessages = normalizeMessagesForMem0(messages);
  if (normalizedMessages.length === 0) {
    return;
  }

  try {
    if (config.mem0Mode === 'openmemory' || config.mem0ApiFlavor === 'openmemory_legacy') {
      const appName = buildOpenMemoryAppName(scope.userId);
      for (const message of normalizedMessages) {
        const contentText = extractTextFromContent(message.content);
        if (!contentText.trim()) {
          continue;
        }

        const response = await fetchMem0WithRetry(
          `${apiBase}/api/v1/memories/`,
          {
            method: 'POST',
            headers: buildMem0Headers(),
            body: JSON.stringify({
              user_id: scope.userId,
              app: appName,
              text: contentText,
              metadata: {
                ...metadata,
                role: message.role,
                agent_id: scope.agentId || undefined,
                run_id: scope.runId || undefined,
                app_id: scope.appId || undefined,
                org_id: scope.orgId || undefined,
                project_id: scope.projectId || undefined,
              },
              infer: config.openmemoryInfer,
            }),
          },
          config.mem0TimeoutMs,
          config.mem0AddRetries,
        );

        if (!response.ok) {
          log.warn('OpenMemory add failed', response.status, await response.text());
        }
      }
      return;
    }

    if (config.mem0Mode === 'platform' || config.mem0ApiFlavor === 'mem0_v2' || config.mem0Mode === 'mem0_compat') {
      const payload = buildMem0WritePayload(scope, normalizedMessages, metadata, reqBody);
      const response = await fetchMem0WithRetry(
        `${apiBase}/v1/memories/`,
        {
          method: 'POST',
          headers: buildMem0Headers(),
          body: JSON.stringify(payload),
        },
        config.mem0TimeoutMs,
        config.mem0AddRetries,
      );

      if (!response.ok) {
        log.warn('Mem0 add failed', response.status, await response.text());
      }
      return;
    }

    const response = await fetchMem0WithRetry(
      `${apiBase}/memories`,
      {
        method: 'POST',
        headers: buildMem0Headers(),
        body: JSON.stringify({
          user_id: scope.userId,
          messages: normalizedMessages,
          metadata,
        }),
      },
      config.mem0TimeoutMs,
      config.mem0AddRetries,
    );

    if (!response.ok) {
      log.warn('Mem0 add failed', response.status, await response.text());
    }
  } catch (error) {
    log.warn('Mem0 add error', error.message);
  }
}

function buildMemoryPrompt(memories) {
  if (!memories || memories.length === 0) return '';
  return `Relevant user memories:\n${memories.map((memory) => `- ${memory}`).join('\n')}`;
}

function shouldStoreUserMessage(textContent, originalContent) {
  if (hasImageInContent(originalContent)) {
    return true;
  }

  if (typeof textContent !== 'string') return false;
  const text = textContent.trim();
  if (!text) return false;

  if (config.mem0StoreStrategy === 'all') {
    return true;
  }

  const lower = text.toLowerCase();
  const normalized = lower.replace(/\s+/g, ' ').trim();

  const blockedPatterns = [
    'provide a concise, 5-word-or-less title for the conversation',
    'only return the title itself',
    'conversation: user:',
  ];

  if (blockedPatterns.some((pattern) => lower.includes(pattern))) {
    return false;
  }

  const questionStarts = [
    'what ',
    'when ',
    'where ',
    'who ',
    'why ',
    'how ',
    'which ',
    'do ',
    'does ',
    'did ',
    'is ',
    'are ',
    'can ',
    'could ',
    'would ',
    'should ',
  ];

  const looksLikeQuestion = normalized.endsWith('?') || questionStarts.some((q) => normalized.startsWith(q));
  if (looksLikeQuestion) {
    return false;
  }

  const rememberSignals = [
    'remember this',
    'remember that',
    'remember i',
    'save this',
    'my favorite',
    'i like',
    'i love',
    'i prefer',
    'i am allergic',
    'my name is',
    'i am ',
    'i work at',
    'i live in',
  ];

  if (rememberSignals.some((pattern) => lower.includes(pattern))) {
    return true;
  }

  const declarativeSignals = [
    /\bmy favorite\b/,
    /\bi (like|love|prefer)\b/,
    /\bi am allergic\b/,
    /\bmy name is\b/,
    /\bi work at\b/,
    /\bi live in\b/,
  ];

  return declarativeSignals.some((rx) => rx.test(normalized));
}

function parseStreamingDelta(state, chunk) {
  state.buffer += chunk;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() || '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.replace(/^data:\s*/, '');
    if (payload === '[DONE]') continue;
    try {
      const json = JSON.parse(payload);
      const delta = json?.choices?.[0]?.delta?.content;
      if (delta) {
        state.assistant += delta;
      }
    } catch (error) {
      log.debug('Failed to parse streaming chunk', error.message);
    }
  }
}

function parseResponsesStreamingDelta(state, chunk) {
  state.buffer += chunk;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() || '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.replace(/^data:\s*/, '');
    if (payload === '[DONE]') continue;
    try {
      const json = JSON.parse(payload);
      const delta = json?.delta || json?.text || json?.output_text || '';
      if (typeof delta === 'string' && delta) {
        state.assistant += delta;
      }
    } catch (error) {
      log.debug('Failed to parse responses chunk', error.message);
    }
  }
}

function buildUpstreamHeaders() {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (config.upstreamApiKey) {
    headers.Authorization = `Bearer ${config.upstreamApiKey}`;
  }

  const extraHeaders = parseJsonEnv(config.upstreamHeaders, {});
  return { ...headers, ...extraHeaders };
}

function buildMem0Metadata({ conversationId, model }) {
  const metadata = { source: 'librechat' };
  if (conversationId) metadata.conversation_id = conversationId;
  if (model) metadata.model = model;
  return metadata;
}

function shouldStoreAssistant(streaming) {
  return config.mem0StoreMode === 'both' && !streaming;
}

function extractAssistantTextFromResponsesPayload(payload) {
  const output = payload?.output || payload?.response?.output || [];
  if (!Array.isArray(output)) return '';

  const chunks = [];
  for (const item of output) {
    if (item?.role && item.role !== 'assistant') continue;
    if (Array.isArray(item?.content)) {
      for (const part of item.content) {
        if (typeof part?.text === 'string') {
          chunks.push(part.text);
        }
      }
    } else if (typeof item?.content === 'string') {
      chunks.push(item.content);
    }
  }

  return chunks.join('\n');
}

function requireApiKey(req, res, next) {
  if (!config.gatewayApiKey) {
    return next();
  }

  const authorization = getHeader(req, 'authorization') || '';
  const token = authorization.replace(/^(Bearer|Token)\s+/i, '').trim();
  const apiKey = token || getHeader(req, 'x-api-key') || '';

  if (apiKey !== config.gatewayApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/v1/models', requireApiKey, (req, res) => {
  const upstreamBase = normalizeBaseUrl(config.upstreamBaseUrl);

  if (!upstreamBase) {
    const models = (process.env.AVAILABLE_MODELS || '')
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean)
      .map((model) => ({ id: model, object: 'model', owned_by: 'mem0-gateway' }));
    return res.json({ object: 'list', data: models });
  }

  return fetchWithTimeout(
    `${upstreamBase}/v1/models`,
    {
      method: 'GET',
      headers: buildUpstreamHeaders(),
    },
    config.upstreamTimeoutMs,
  )
    .then(async (upstreamResponse) => {
      if (!upstreamResponse.ok) {
        const text = await upstreamResponse.text();
        log.warn('Upstream model list fetch failed', upstreamResponse.status, text);
        const fallback = (process.env.AVAILABLE_MODELS || '')
          .split(',')
          .map((model) => model.trim())
          .filter(Boolean)
          .map((model) => ({ id: model, object: 'model', owned_by: 'mem0-gateway' }));
        return res.json({ object: 'list', data: fallback });
      }

      const payload = await upstreamResponse.json();
      if (Array.isArray(payload?.data)) {
        return res.json(payload);
      }

      const fallback = (process.env.AVAILABLE_MODELS || '')
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean)
        .map((model) => ({ id: model, object: 'model', owned_by: 'mem0-gateway' }));
      return res.json({ object: 'list', data: fallback });
    })
    .catch((error) => {
      log.warn('Upstream model list fetch error', error.message);
      const fallback = (process.env.AVAILABLE_MODELS || '')
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean)
        .map((model) => ({ id: model, object: 'model', owned_by: 'mem0-gateway' }));
      return res.json({ object: 'list', data: fallback });
    });
});

app.post('/v1/chat/completions', requireApiKey, async (req, res) => {
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const streaming = body.stream === true;
  const conversationId = getConversationId(req, body);
  const scope = getMemoryScope(req, body, conversationId);
  const lastUserMessageData = getLastUserMessageData(messages);
  const lastUserMessage = lastUserMessageData.text;
  const lastUserMessageContent = lastUserMessageData.content;

  let memories = [];
  if (lastUserMessage && scope.userId) {
    await waitForPendingMemoryWrite(scope);
    memories = await mem0Search({ scope, query: lastUserMessage, req, body });
  }

  const memoryPrompt = buildMemoryPrompt(memories);
  const nextMessages = memoryPrompt
    ? injectMemoriesIntoMessages(messages, memoryPrompt)
    : messages;

  const upstreamBody = {
    ...body,
    messages: nextMessages,
  };

  const upstreamBase = normalizeBaseUrl(config.upstreamBaseUrl);
  if (!upstreamBase) {
    return res.status(500).json({ error: 'UPSTREAM_BASE_URL is not set' });
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetchWithTimeout(
      `${upstreamBase}/v1/chat/completions`,
      {
        method: 'POST',
        headers: buildUpstreamHeaders(),
        body: JSON.stringify(upstreamBody),
      },
      config.upstreamTimeoutMs,
    );
  } catch (error) {
    log.error('Upstream request failed', error.message);
    return res.status(502).json({ error: 'Upstream request failed' });
  }

  if (streaming) {
    res.status(upstreamResponse.status);
    upstreamResponse.headers.forEach((value, key) => {
      if (['content-length', 'content-encoding', 'transfer-encoding'].includes(key)) return;
      res.setHeader(key, value);
    });

    if (!upstreamResponse.body) {
      res.end();
      return;
    }

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    const state = { buffer: '', assistant: '' };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
        if (config.mem0StoreMode === 'both') {
          parseStreamingDelta(state, chunk);
        }
      }
    } catch (error) {
      log.warn('Streaming proxy error', error.message);
    } finally {
      res.end();
      const messagesToStore = [];
      const shouldStoreUser = shouldStoreUserMessage(lastUserMessage, lastUserMessageContent);

      if (config.mem0StoreMode === 'user_only' && shouldStoreUser) {
        messagesToStore.push({ role: 'user', content: lastUserMessageContent || lastUserMessage });
      }

      if (config.mem0StoreMode === 'both' && shouldStoreUser && state.assistant) {
        messagesToStore.push({ role: 'user', content: lastUserMessageContent || lastUserMessage });
        messagesToStore.push({ role: 'assistant', content: state.assistant });
      }

      if (messagesToStore.length > 0) {
        void enqueueMemoryWrite(scope, () =>
          mem0Add({
            scope,
            messages: messagesToStore,
            metadata: buildMem0Metadata({ conversationId, model: body.model }),
            reqBody: body,
          }),
        );
      }
    }

    return;
  }

  let payload;
  try {
    payload = await upstreamResponse.json();
  } catch (error) {
    log.warn('Failed to parse upstream response', error.message);
    return res.status(502).json({ error: 'Invalid upstream response' });
  }

  res.status(upstreamResponse.status).json(payload);

  const assistantMessage = payload?.choices?.[0]?.message?.content || '';
  const messagesToStore = [];
  const shouldStoreUser = shouldStoreUserMessage(lastUserMessage, lastUserMessageContent);

  if (config.mem0StoreMode === 'user_only' && shouldStoreUser) {
    messagesToStore.push({ role: 'user', content: lastUserMessageContent || lastUserMessage });
  }

  if (shouldStoreAssistant(false) && shouldStoreUser && assistantMessage) {
    messagesToStore.push({ role: 'user', content: lastUserMessageContent || lastUserMessage });
    messagesToStore.push({ role: 'assistant', content: assistantMessage });
  }

  if (messagesToStore.length > 0) {
    void enqueueMemoryWrite(scope, () =>
      mem0Add({
        scope,
        messages: messagesToStore,
        metadata: buildMem0Metadata({ conversationId, model: body.model }),
        reqBody: body,
      }),
    );
  }
});

app.post('/v1/responses', requireApiKey, async (req, res) => {
  const body = req.body || {};
  const inputField = body.input !== undefined ? 'input' : Array.isArray(body.messages) ? 'messages' : 'input';
  const input = body[inputField];
  const streaming = body.stream === true;
  const conversationId = getConversationId(req, body);
  const scope = getMemoryScope(req, body, conversationId);
  const lastUserMessageData = getLastUserMessageDataFromResponsesInput(input);
  const lastUserMessage = lastUserMessageData.text;
  const lastUserMessageContent = lastUserMessageData.content;

  let memories = [];
  if (lastUserMessage && scope.userId) {
    await waitForPendingMemoryWrite(scope);
    memories = await mem0Search({ scope, query: lastUserMessage, req, body });
  }

  const memoryPrompt = buildMemoryPrompt(memories);
  const upstreamBody = { ...body };

  if (memoryPrompt) {
    if (Array.isArray(input)) {
      upstreamBody[inputField] = injectMemoriesIntoResponsesMessages(input, memoryPrompt);
    } else if (typeof input === 'string') {
      if (typeof upstreamBody.instructions === 'string' && upstreamBody.instructions.trim()) {
        upstreamBody.instructions = `${upstreamBody.instructions}\n\n${memoryPrompt}`;
      } else {
        upstreamBody.instructions = memoryPrompt;
      }
    }
  }

  const upstreamBase = normalizeBaseUrl(config.upstreamBaseUrl);
  if (!upstreamBase) {
    return res.status(500).json({ error: 'UPSTREAM_BASE_URL is not set' });
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetchWithTimeout(
      `${upstreamBase}/v1/responses`,
      {
        method: 'POST',
        headers: buildUpstreamHeaders(),
        body: JSON.stringify(upstreamBody),
      },
      config.upstreamTimeoutMs,
    );
  } catch (error) {
    log.error('Upstream request failed', error.message);
    return res.status(502).json({ error: 'Upstream request failed' });
  }

  if (streaming) {
    res.status(upstreamResponse.status);
    upstreamResponse.headers.forEach((value, key) => {
      if (['content-length', 'content-encoding', 'transfer-encoding'].includes(key)) return;
      res.setHeader(key, value);
    });

    if (!upstreamResponse.body) {
      res.end();
      return;
    }

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    const state = { buffer: '', assistant: '' };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
        if (config.mem0StoreMode === 'both') {
          parseResponsesStreamingDelta(state, chunk);
        }
      }
    } catch (error) {
      log.warn('Streaming proxy error', error.message);
    } finally {
      res.end();
      const messagesToStore = [];
      const shouldStoreUser = shouldStoreUserMessage(lastUserMessage, lastUserMessageContent);

      if (config.mem0StoreMode === 'user_only' && shouldStoreUser) {
        messagesToStore.push({ role: 'user', content: lastUserMessageContent || lastUserMessage });
      }

      if (config.mem0StoreMode === 'both' && shouldStoreUser && state.assistant) {
        messagesToStore.push({ role: 'user', content: lastUserMessageContent || lastUserMessage });
        messagesToStore.push({ role: 'assistant', content: state.assistant });
      }

      if (messagesToStore.length > 0) {
        void enqueueMemoryWrite(scope, () =>
          mem0Add({
            scope,
            messages: messagesToStore,
            metadata: buildMem0Metadata({ conversationId, model: body.model }),
            reqBody: body,
          }),
        );
      }
    }

    return;
  }

  let payload;
  try {
    payload = await upstreamResponse.json();
  } catch (error) {
    log.warn('Failed to parse upstream response', error.message);
    return res.status(502).json({ error: 'Invalid upstream response' });
  }

  res.status(upstreamResponse.status).json(payload);

  const assistantMessage = extractAssistantTextFromResponsesPayload(payload);
  const messagesToStore = [];
  const shouldStoreUser = shouldStoreUserMessage(lastUserMessage, lastUserMessageContent);

  if (config.mem0StoreMode === 'user_only' && shouldStoreUser) {
    messagesToStore.push({ role: 'user', content: lastUserMessageContent || lastUserMessage });
  }

  if (shouldStoreAssistant(false) && shouldStoreUser && assistantMessage) {
    messagesToStore.push({ role: 'user', content: lastUserMessageContent || lastUserMessage });
    messagesToStore.push({ role: 'assistant', content: assistantMessage });
  }

  if (messagesToStore.length > 0) {
    void enqueueMemoryWrite(scope, () =>
      mem0Add({
        scope,
        messages: messagesToStore,
        metadata: buildMem0Metadata({ conversationId, model: body.model }),
        reqBody: body,
      }),
    );
  }
});

app.listen(port, () => {
  log.info(`Mem0 gateway listening on port ${port}`);
});
