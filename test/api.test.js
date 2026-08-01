import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApiServer } from '../src/http-api.js';
import { resolveModel } from '../src/models.js';
import { buildPrompt } from '../src/prompt.js';
import { finalText, terminalResponse } from '../src/response.js';

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

test('OpenAI-compatible endpoint returns runner output', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'freebuff-api-test-'));
  const calls = [];
  const server = createApiServer({
    defaultCwd: temp,
    runner: {
      async run(options) {
        calls.push(options);
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
  assert.match(page.contentType, /^text\/html/);
  assert.match(page.body, /Freebuff Local Console/);

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
});
