const fs = require('fs');
const path = require('path');
const express = require('express');

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const app = express();
const port = Number(process.env.PORT || 8001);

app.use(express.json({ limit: process.env.BODY_LIMIT || '2mb' }));

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
  mem0TimeoutMs: Number(process.env.MEM0_TIMEOUT_MS || 10000),
  mem0SearchTopK: Number(process.env.MEM0_SEARCH_TOP_K || 6),
  mem0MaxMemories: Number(process.env.MEM0_MAX_MEMORIES || 6),
  mem0Threshold: Number(process.env.MEM0_THRESHOLD || 0.3),
  mem0StoreMode: process.env.MEM0_STORE_MODE || 'user_only',
  mem0StoreStrategy: process.env.MEM0_STORE_STRATEGY || 'selective',
  mem0InjectRole: process.env.MEM0_INJECT_ROLE || 'system',
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

function getLastUserMessage(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return '';
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

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        if (typeof item?.content === 'string') return item.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
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

function buildMem0Headers() {
  const headers = { 'Content-Type': 'application/json' };
  if (config.mem0ApiKey) {
    headers.Authorization = `Token ${config.mem0ApiKey}`;
  }
  return headers;
}

async function mem0Search({ userId, query }) {
  if (!config.mem0Enabled || !userId || !query) return [];

  const apiBase = normalizeBaseUrl(config.mem0ApiBase);

  try {
    if (config.mem0Mode === 'openmemory') {
      const buildOpenMemoryUrl = (withQuery = true) => {
        const url = new URL(`${apiBase}/api/v1/memories/`);
        url.searchParams.set('user_id', userId);
        if (withQuery && query) {
          url.searchParams.set('search_query', query);
        }
        url.searchParams.set('page', '1');
        url.searchParams.set('size', String(Math.max(config.mem0SearchTopK, config.mem0MaxMemories)));
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
        .map((item) => item?.content || item?.text || item?.memory || '')
        .filter(Boolean)
        .slice(0, config.mem0MaxMemories);
    }

    if (config.mem0Mode === 'platform') {
      const response = await fetchWithTimeout(
        `${apiBase}/v2/memories/search/`,
        {
          method: 'POST',
          headers: buildMem0Headers(),
          body: JSON.stringify({
            query,
            version: 'v2',
            filters: { user_id: userId },
            top_k: config.mem0SearchTopK,
            threshold: config.mem0Threshold,
          }),
        },
        config.mem0TimeoutMs,
      );

      if (!response.ok) {
        log.warn('Mem0 search failed', response.status, await response.text());
        return [];
      }

      const data = await response.json();
      return extractMemoriesFromResponse(data, config.mem0Threshold);
    }

    const url = new URL(`${apiBase}/memories/search`);
    url.searchParams.set('user_id', userId);
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
    return extractMemoriesFromResponse(data, config.mem0Threshold);
  } catch (error) {
    log.warn('Mem0 search error', error.message);
    return [];
  }
}

function extractMemoriesFromResponse(data, threshold) {
  let items = [];

  if (Array.isArray(data)) {
    items = data;
  } else if (Array.isArray(data?.memories)) {
    items = data.memories;
  } else if (Array.isArray(data?.results)) {
    items = data.results;
  } else if (Array.isArray(data?.data)) {
    items = data.data;
  }

  return items
    .filter((item) => {
      if (typeof item?.score === 'number') {
        return item.score >= threshold;
      }
      return true;
    })
    .map((item) => item?.memory || item?.value || item?.text || '')
    .filter(Boolean)
    .slice(0, config.mem0MaxMemories);
}

async function mem0Add({ userId, messages, metadata }) {
  if (!config.mem0Enabled || !userId || !Array.isArray(messages) || messages.length === 0) {
    return;
  }

  const apiBase = normalizeBaseUrl(config.mem0ApiBase);

  try {
    if (config.mem0Mode === 'openmemory') {
      const appName = buildOpenMemoryAppName(userId);
      for (const message of messages) {
        if (typeof message?.content !== 'string' || !message.content.trim()) {
          continue;
        }

        const response = await fetchWithTimeout(
          `${apiBase}/api/v1/memories/`,
          {
            method: 'POST',
            headers: buildMem0Headers(),
            body: JSON.stringify({
              user_id: userId,
              app: appName,
              text: message.content,
              metadata: {
                ...metadata,
                role: message.role,
              },
              infer: config.openmemoryInfer,
            }),
          },
          config.mem0TimeoutMs,
        );

        if (!response.ok) {
          log.warn('OpenMemory add failed', response.status, await response.text());
        }
      }
      return;
    }

    if (config.mem0Mode === 'platform') {
      const response = await fetchWithTimeout(
        `${apiBase}/v1/memories/`,
        {
          method: 'POST',
          headers: buildMem0Headers(),
          body: JSON.stringify({
            user_id: userId,
            messages,
            metadata,
          }),
        },
        config.mem0TimeoutMs,
      );

      if (!response.ok) {
        log.warn('Mem0 add failed', response.status, await response.text());
      }
      return;
    }

    const response = await fetchWithTimeout(
      `${apiBase}/memories`,
      {
        method: 'POST',
        headers: buildMem0Headers(),
        body: JSON.stringify({
          user_id: userId,
          messages,
          metadata,
        }),
      },
      config.mem0TimeoutMs,
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

function shouldStoreUserMessage(content) {
  if (typeof content !== 'string') return false;
  const text = content.trim();
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
  const userId = resolveMemoryUserId(getUserId(req, body));
  const conversationId = getConversationId(req, body);
  const lastUserMessage = getLastUserMessage(messages);

  let memories = [];
  if (lastUserMessage && userId) {
    memories = await mem0Search({ userId, query: lastUserMessage });
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

      if (config.mem0StoreMode === 'user_only' && shouldStoreUserMessage(lastUserMessage)) {
        messagesToStore.push({ role: 'user', content: lastUserMessage });
      }

      if (config.mem0StoreMode === 'both' && lastUserMessage && state.assistant) {
        messagesToStore.push({ role: 'user', content: lastUserMessage });
        messagesToStore.push({ role: 'assistant', content: state.assistant });
      }

      if (messagesToStore.length > 0) {
        void mem0Add({
          userId,
          messages: messagesToStore,
          metadata: buildMem0Metadata({ conversationId, model: body.model }),
        });
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

  if (config.mem0StoreMode === 'user_only' && shouldStoreUserMessage(lastUserMessage)) {
    messagesToStore.push({ role: 'user', content: lastUserMessage });
  }

  if (shouldStoreAssistant(false) && lastUserMessage && assistantMessage) {
    messagesToStore.push({ role: 'user', content: lastUserMessage });
    messagesToStore.push({ role: 'assistant', content: assistantMessage });
  }

  if (messagesToStore.length > 0) {
    void mem0Add({
      userId,
      messages: messagesToStore,
      metadata: buildMem0Metadata({ conversationId, model: body.model }),
    });
  }
});

app.post('/v1/responses', requireApiKey, async (req, res) => {
  const body = req.body || {};
  const inputField = body.input !== undefined ? 'input' : Array.isArray(body.messages) ? 'messages' : 'input';
  const input = body[inputField];
  const streaming = body.stream === true;
  const userId = resolveMemoryUserId(getUserId(req, body));
  const conversationId = getConversationId(req, body);
  const lastUserMessage = getLastUserMessageFromResponsesInput(input);

  let memories = [];
  if (lastUserMessage && userId) {
    memories = await mem0Search({ userId, query: lastUserMessage });
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

      if (config.mem0StoreMode === 'user_only' && shouldStoreUserMessage(lastUserMessage)) {
        messagesToStore.push({ role: 'user', content: lastUserMessage });
      }

      if (config.mem0StoreMode === 'both' && lastUserMessage && state.assistant) {
        messagesToStore.push({ role: 'user', content: lastUserMessage });
        messagesToStore.push({ role: 'assistant', content: state.assistant });
      }

      if (messagesToStore.length > 0) {
        void mem0Add({
          userId,
          messages: messagesToStore,
          metadata: buildMem0Metadata({ conversationId, model: body.model }),
        });
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

  if (config.mem0StoreMode === 'user_only' && shouldStoreUserMessage(lastUserMessage)) {
    messagesToStore.push({ role: 'user', content: lastUserMessage });
  }

  if (shouldStoreAssistant(false) && lastUserMessage && assistantMessage) {
    messagesToStore.push({ role: 'user', content: lastUserMessage });
    messagesToStore.push({ role: 'assistant', content: assistantMessage });
  }

  if (messagesToStore.length > 0) {
    void mem0Add({
      userId,
      messages: messagesToStore,
      metadata: buildMem0Metadata({ conversationId, model: body.model }),
    });
  }
});

app.listen(port, () => {
  log.info(`Mem0 gateway listening on port ${port}`);
});
