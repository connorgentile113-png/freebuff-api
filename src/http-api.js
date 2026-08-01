import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MODELS, resolveModel } from './models.js';
import { buildPrompt } from './prompt.js';

const MAX_BODY_BYTES = 1024 * 1024;
const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

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

async function sendStatic(response, pathname) {
  const [filename, contentType] = staticFiles.get(pathname);
  const body = await fs.readFile(path.join(publicDirectory, filename));
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': filename === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
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

export function createApiServer({ runner, apiKey = process.env.FREEBUFF_API_KEY, defaultCwd } = {}) {
  if (!runner) throw new TypeError('runner is required');
  const fallbackCwd = defaultCwd ?? process.env.FREEBUFF_CWD ?? path.join(os.tmpdir(), 'freebuff-api-workspace');
  let queue = Promise.resolve();

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && staticFiles.has(url.pathname)) {
      try {
        await sendStatic(response, url.pathname);
      } catch (error) {
        apiError(response, 500, error.message, 'server_error');
      }
      return;
    }

    if (!authorized(request, apiKey)) {
      apiError(response, 401, 'Invalid or missing bearer token', 'authentication_error');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok', backend: 'freebuff-cli' });
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
      if (body.stream === true) throw new TypeError('stream=true is not supported by this CLI bridge');
      const model = resolveModel(body.model);
      if (!model) throw new TypeError(`Unknown model. Use one of: ${MODELS.map((item) => item.id).join(', ')}`);
      const prompt = buildPrompt(body.messages);
      await fs.mkdir(fallbackCwd, { recursive: true });
      const cwd = await resolveCwd(body.cwd, fallbackCwd);

      const task = () => runner.run({ modelId: model.id, prompt, cwd, signal: controller.signal });
      const resultPromise = queue.then(task, task);
      queue = resultPromise.catch(() => {});
      const content = await resultPromise;
      sendJson(response, 200, {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model.id,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      });
    } catch (error) {
      if (response.headersSent) return;
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
