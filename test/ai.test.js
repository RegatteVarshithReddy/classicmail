'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../electron/services/store');
const { AiService, MAX_CONTEXT_CHARS, estimateCostUsd, PRICE_PER_MTOK_INPUT, PRICE_PER_MTOK_OUTPUT } = require('../electron/services/ai');
const { tempDir, dummySecrets } = require('./helpers');

function fakeResponse({ status = 200, body = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function setup(fetchImpl) {
  const store = new Store(tempDir(), dummySecrets);
  store.setAiConfig({ enabled: true, apiKey: 'test-api-key' });
  const svc = new AiService(store, { fetchImpl });
  return { store, svc };
}

test('draftReply: sends the expected request, extracts the text, and reports token usage', async () => {
  let captured;
  const { svc } = setup(async (url, options) => {
    captured = { url, options };
    return fakeResponse({ body: { content: [{ type: 'text', text: 'Thanks for reaching out.' }], usage: { input_tokens: 120, output_tokens: 18 } } });
  });
  const result = await svc.draftReply({ subject: 'Hello', quotedText: 'Original message body', instruction: 'Say thanks', mode: 'reply' });
  assert.equal(result.text, 'Thanks for reaching out.');
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 18 });

  assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['x-api-key'], 'test-api-key');
  assert.equal(captured.options.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(captured.options.body);
  assert.equal(body.messages.length, 1);
  assert.match(body.messages[0].content, /Say thanks/);
  assert.match(body.messages[0].content, /Hello/);
  assert.match(body.messages[0].content, /Original message body/);
});

test('draftReply: truncates the quoted text to MAX_CONTEXT_CHARS', async () => {
  const long = 'x'.repeat(MAX_CONTEXT_CHARS + 500);
  let captured;
  const { svc } = setup(async (url, options) => { captured = options; return fakeResponse({ body: { content: [{ text: 'ok' }] } }); });
  await svc.draftReply({ subject: '', quotedText: long, instruction: 'Reply', mode: 'reply' });
  const sent = JSON.parse(captured.body).messages[0].content;
  assert.ok(!sent.includes('x'.repeat(MAX_CONTEXT_CHARS + 1)), 'quoted text was not truncated');
  assert.ok(sent.includes('x'.repeat(MAX_CONTEXT_CHARS)), 'quoted text was truncated too aggressively');
});

test('draftReply: falls back to a mode-appropriate instruction when none is given', async () => {
  let captured;
  const { svc } = setup(async (url, options) => { captured = options; return fakeResponse({ body: { content: [{ text: 'ok' }] } }); });
  await svc.draftReply({ subject: '', quotedText: '', instruction: '', mode: 'forward' });
  assert.match(JSON.parse(captured.body).messages[0].content, /forward/i);
});

test('draftReply: a rejected API key produces a clear error', async () => {
  const { svc } = setup(async () => fakeResponse({ status: 401 }));
  await assert.rejects(() => svc.draftReply({ subject: '', quotedText: '', instruction: 'Reply', mode: 'reply' }), /API key/);
});

test('draftReply: a non-OK response produces a clear error', async () => {
  const { svc } = setup(async () => fakeResponse({ status: 500 }));
  await assert.rejects(() => svc.draftReply({ subject: '', quotedText: '', instruction: 'Reply', mode: 'reply' }), /500/);
});

test('draftReply: an empty completion is treated as an error', async () => {
  const { svc } = setup(async () => fakeResponse({ body: { content: [] } }));
  await assert.rejects(() => svc.draftReply({ subject: '', quotedText: '', instruction: 'Reply', mode: 'reply' }), /empty/i);
});

test('draftReply: refuses when no key has been saved', async () => {
  const store = new Store(tempDir(), dummySecrets);
  const svc = new AiService(store, { fetchImpl: async () => { throw new Error('no network expected'); } });
  await assert.rejects(() => svc.draftReply({ subject: '', quotedText: '', instruction: 'Reply', mode: 'reply' }), /No Claude API key/);
});

test('draftReply: missing usage in the response is treated as zero, not a crash', async () => {
  const { svc } = setup(async () => fakeResponse({ body: { content: [{ text: 'ok' }] } }));
  const result = await svc.draftReply({ subject: '', quotedText: '', instruction: 'Reply', mode: 'reply' });
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
});

test('estimateCostUsd: matches Claude Haiku 4.5 list pricing', () => {
  assert.equal(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }), PRICE_PER_MTOK_INPUT);
  assert.equal(estimateCostUsd({ inputTokens: 0, outputTokens: 1_000_000 }), PRICE_PER_MTOK_OUTPUT);
  assert.equal(estimateCostUsd({ inputTokens: 500_000, outputTokens: 100_000 }), PRICE_PER_MTOK_INPUT * 0.5 + PRICE_PER_MTOK_OUTPUT * 0.1);
  assert.equal(estimateCostUsd(), 0);
  assert.equal(estimateCostUsd({}), 0);
});
