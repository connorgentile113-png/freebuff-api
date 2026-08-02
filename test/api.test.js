import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FreebuffRunner } from '../src/freebuff-runner.js';
import { createApiServer } from '../src/http-api.js';
import { resolveModel } from '../src/models.js';
import { buildPrompt } from '../src/prompt.js';
import { finalText, terminalResponse } from '../src/response.js';
import { findLoginUrl } from '../src/setup.js';

test('model aliases resolve to canonical IDs', () => {
  assert.equal(resolveModel('minimax').id, 'minimax/minimax-m3');
  assert.equal(resolveModel('deepseek').id, 'deepseek/deepseek-v4-flash');
  assert.equal(resolveModel('missing'), null);
});

test('prompt accepts OpenAI text parts', () => {
  const prompt = buildPrompt([
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
  ]);
  assert.match(prompt, /System:\nBe concise/);
  assert.match(prompt, /User:\nHello/);
});

test('completion extraction omits reasoning', () => {
  assert.equal(
    finalText({
      blocks: [
        { type: 'text', textType: 'reasoning', content: 'secret thought' },
        { type: 'text', textType: 'text', content: 'Final answer' },
      ],
    }),
    'Final answer',
  );
});

test('terminal extraction omits the thinking block and footer', () => {
  const screen = [
    '  Prompt text ⎘',
    '  • Thinking',
    '    internal reasoning',
    '  Final answer',
    '  with two lines',
    ' DeepSeek V4 Flash · unlimited',
    '│  Enter a coding task or / for commands │',
  ].join('\n');
  assert.equal(terminalResponse(screen, 'Prompt text'), 'Final answer\nwith two lines');
});

test('setup extracts the Freebuff login URL without exposing other output', () => {
  assert.equal(
    findLoginUrl('\u001b[32mOpen this URL:\u001b[0m https://auth.example.test/login?code=abc\nWaiting…'),
    'https://auth.example.test/login?code=abc',
  );
  assert.equal(findLoginUrl('No URL yet'), null);
});

test('runner reuses a compatible session and stops it after the idle window', async () => {
  const sessions = [];
  const runner = new FreebuffRunner({
    idleTimeoutMs: 25,
    sessionFactory(options) {
      const session = {
        ...options,
        requestCount: 0,
        started: false,
        stopped: false,
        async start() { this.started = true; },
        async run({ prompt, onDelta }) {
          this.requestCount += 1;
          onDelta?.(prompt);
          return prompt;
        },
        async stop() { this.stopped = true; },
      };
      sessions.push(session);
      return session;
    },
  });

  assert.equal(runner.status().state, 'stopped');
  assert.equal(await runner.run({ modelId: 'deepseek', prompt: 'one', cwd: '/tmp' }), 'one');
  assert.equal(await runner.run({ modelId: 'deepseek', prompt: 'two', cwd: '/tmp' }), 'two');
  assert.equal(sessions.length, 1);
  assert.equal(runner.status().state, 'ready');
  assert.equal(runner.status().request_count, 2);
  assert.ok(runner.status().expires_at);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(runner.status().state, 'stopped');
  assert.equal(sessions[0].stopped, true);
});

test('runner replaces a cached session when the requested model changes', async () => {
  const sessions = [];
  const runner = new FreebuffRunner({
    idleTimeoutMs: 1_000,
    sessionFactory(options) {
      const session = {
        ...options,
        requestCount: 0,
        stopped: false,
        async start() {},
        async run() { this.requestCount += 1; return options.modelId; },
        async stop() { this.stopped = true; },
      };
      sessions.push(session);
      return session;
    },
  });
  await runner.run({ modelId: 'deepseek', prompt: 'one', cwd: '/tmp' });
  await runner.run({ modelId: 'minimax', prompt: 'two', cwd: '/tmp' });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].stopped, true);
  assert.equal(runner.status().model, 'minimax/minimax-m3');
  await runner.close();
});

test('runner retries a transient Freebuff session-service startup failure', async () => {
  let attempts = 0;
  const runner = new FreebuffRunner({
    idleTimeoutMs: 1_000,
    startupAttempts: 2,
    startupRetryMs: 1,
    sessionFactory(options) {
      return {
        ...options,
        requestCount: 0,
        async start() {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error('temporarily busy');
            error.retryable = true;
            throw error;
          }
        },
        async run() { this.requestCount += 1; return 'recovered'; },
        async stop() {},
      };
    },
  });
  assert.equal(
    await runner.run({ modelId: 'deepseek', prompt: 'hello', cwd: '/tmp' }),
    'recovered',
  );
  assert.equal(attempts, 2);
  await runner.close();
});

test('OpenAI-compatible endpoint returns runner output', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'freebuff-api-test-'));
  const calls = [];
  const server = createApiServer({
    defaultCwd: temp,
    runner: {
      status() {
        return { state: 'stopped' };
      },
      async run(options) {
        calls.push(options);
        options.onDelta?.('hello ');
        options.onDelta?.('from Freebuff');
        return 'hello from Freebuff';
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
    await rm(temp, { recursive: true, force: true });
  });

  const { port } = server.address();
  const page = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/' }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({
        status: incoming.statusCode,
        contentType: incoming.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
  assert.equal(page.status, 200);
  assert.match(page.contentType, /^application\/json/);
  assert.equal(JSON.parse(page.body).api, 'openai-compatible');

  const response = await new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } },
      (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => resolve({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify({ model: 'minimax', messages: [{ role: 'user', content: 'Say hello' }] }));
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.choices[0].message.content, 'hello from Freebuff');
  assert.equal(calls[0].modelId, 'minimax/minimax-m3');

  const streamed = await new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } },
      (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => resolve({
          status: incoming.statusCode,
          contentType: incoming.headers['content-type'],
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify({
      model: 'deepseek',
      stream: true,
      messages: [{ role: 'user', content: 'Say hello' }],
    }));
  });

  assert.equal(streamed.status, 200);
  assert.match(streamed.contentType, /^text\/event-stream/);
  assert.match(streamed.body, /"content":"hello "/);
  assert.match(streamed.body, /"content":"from Freebuff"/);
  assert.match(streamed.body, /"finish_reason":"stop"/);
  assert.match(streamed.body, /data: \[DONE\]/);
});

test('browser CORS is opt-in while ordinary local clients remain unrestricted', async (t) => {
  const server = createApiServer({
    corsOrigins: 'http://tool-ai.local',
    runner: { async run() { return 'ok'; } },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });
  const { port } = server.address();

  async function request(origin) {
    return new Promise((resolve, reject) => {
      const outgoing = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/health',
        headers: origin ? { origin } : {},
      }, (incoming) => {
        incoming.resume();
        incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers }));
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
  }

  const ordinaryClient = await request();
  assert.equal(ordinaryClient.status, 200);
  assert.equal(ordinaryClient.headers['access-control-allow-origin'], undefined);
  const rejectedBrowser = await request('http://other.local');
  assert.equal(rejectedBrowser.status, 403);
  assert.equal(rejectedBrowser.headers['access-control-allow-origin'], undefined);
  assert.equal(
    (await request('http://tool-ai.local')).headers['access-control-allow-origin'],
    'http://tool-ai.local',
  );
});
