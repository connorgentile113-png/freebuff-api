import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MODELS, resolveModel } from './models.js';
import { buildPrompt } from './prompt.js';

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function apiError(response, status, message, type = 'invalid_request_error') {
  sendJson(response, status, { error: { message, type } });
}

function sendSse(response, value) {
  if (!response.destroyed && !response.writableEnded) {
    response.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
  }
}

function completionChunk({ id, created, model, delta, finishReason = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new RangeError('Request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SyntaxError('Request body must be valid JSON');
  }
}

async function resolveCwd(value, defaultCwd) {
  const cwd = value ?? defaultCwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new TypeError('cwd must be an absolute directory path');
  }
  const stats = await fs.stat(cwd);
  if (!stats.isDirectory()) throw new TypeError('cwd must be a directory');
  return cwd;
}

function authorized(request, apiKey) {
  if (!apiKey) return true;
  return request.headers.authorization === `Bearer ${apiKey}`;
}

function parseCorsOrigins(value) {
  if (!value) return new Set();
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set(value.split(',').map((origin) => origin.trim()).filter(Boolean));
}

function applyCors(request, response, allowedOrigins) {
  const origin = request.headers.origin;
  if (!origin || (!allowedOrigins.has('*') && !allowedOrigins.has(origin))) return false;
  response.setHeader('access-control-allow-origin', allowedOrigins.has('*') ? '*' : origin);
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
  response.setHeader('access-control-max-age', '600');
  response.setHeader('vary', 'Origin');
  return true;
}

export function createApiServer({
  runner,
  apiKey = process.env.FREEBUFF_API_KEY,
  defaultCwd,
  corsOrigins = process.env.FREEBUFF_CORS_ORIGINS,
} = {}) {
  if (!runner) throw new TypeError('runner is required');
  const fallbackCwd = defaultCwd ?? process.env.FREEBUFF_CWD ?? path.join(os.tmpdir(), 'freebuff-api-workspace');
  const allowedOrigins = parseCorsOrigins(corsOrigins);
  let queue = Promise.resolve();

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const corsAllowed = applyCors(request, response, allowedOrigins);
    if (request.headers.origin && !corsAllowed) {
      apiError(response, 403, 'Browser origin is not allowed', 'cors_error');
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (!authorized(request, apiKey)) {
      apiError(response, 401, 'Invalid or missing bearer token', 'authentication_error');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/') {
      const localHost = request.socket.localAddress?.includes(':') ? '[::1]' : '127.0.0.1';
      sendJson(response, 200, {
        name: 'freebuff-local-api',
        api: 'openai-compatible',
        base_url: `http://${localHost}:${request.socket.localPort}/v1`,
        endpoints: ['/health', '/v1/models', '/v1/chat/completions'],
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, {
        status: 'ok',
        backend: 'freebuff-cli',
        freebuff: typeof runner.status === 'function' ? runner.status() : { state: 'unknown' },
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(response, 200, {
        object: 'list',
        data: MODELS.map((model) => ({ id: model.id, object: 'model', owned_by: 'freebuff' })),
      });
      return;
    }

    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      apiError(response, 404, 'Not found');
      return;
    }

    const controller = new AbortController();
    request.on('aborted', () => controller.abort());
    response.on('close', () => {
      if (!response.writableEnded) controller.abort();
    });
    try {
      const body = await readJson(request);
      const model = resolveModel(body.model);
      if (!model) throw new TypeError(`Unknown model. Use one of: ${MODELS.map((item) => item.id).join(', ')}`);
      const prompt = buildPrompt(body.messages);
      await fs.mkdir(fallbackCwd, { recursive: true });
      const cwd = await resolveCwd(body.cwd, fallbackCwd);
      const stream = body.stream === true;
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      let streamedContent = '';

      if (stream) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        response.flushHeaders();
        sendSse(response, completionChunk({
          id,
          created,
          model: model.id,
          delta: { role: 'assistant' },
        }));
      }

      const task = () => runner.run({
        modelId: model.id,
        prompt,
        cwd,
        signal: controller.signal,
        onDelta: stream ? (content) => {
          streamedContent += content;
          sendSse(response, completionChunk({
            id,
            created,
            model: model.id,
            delta: { content },
          }));
        } : undefined,
      });
      const resultPromise = queue.then(task, task);
      queue = resultPromise.catch(() => {});
      const content = await resultPromise;

      if (stream) {
        if (content.startsWith(streamedContent)) {
          const remainder = content.slice(streamedContent.length);
          if (remainder) {
            sendSse(response, completionChunk({
              id,
              created,
              model: model.id,
              delta: { content: remainder },
            }));
          }
        } else if (!streamedContent && content) {
          sendSse(response, completionChunk({
            id,
            created,
            model: model.id,
            delta: { content },
          }));
        }
        sendSse(response, completionChunk({
          id,
          created,
          model: model.id,
          delta: {},
          finishReason: 'stop',
        }));
        sendSse(response, '[DONE]');
        response.end();
        return;
      }

      sendJson(response, 200, {
        id,
        object: 'chat.completion',
        created,
        model: model.id,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      });
    } catch (error) {
      if (response.headersSent) {
        if (!controller.signal.aborted) {
          sendSse(response, { error: { message: error.message, type: 'freebuff_error' } });
          sendSse(response, '[DONE]');
          response.end();
        }
        return;
      }
      if (error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError || error.code === 'ENOENT') {
        apiError(response, 400, error.message);
      } else if (controller.signal.aborted) {
        apiError(response, 499, 'Client closed the request');
      } else {
        apiError(response, error.message.includes('timed out') ? 504 : 502, error.message, 'freebuff_error');
      }
    }
  });
}
