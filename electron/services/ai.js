'use strict';
/**
 * Opt-in "Draft with Claude" feature. Only called when the user has explicitly turned it on and
 * saved their own Anthropic API key in Settings -> AI (see Store.getAiConfig/setAiConfig).
 */
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_CONTEXT_CHARS = 6000;
const MAX_TOKENS = 700;
// Claude Haiku 4.5 list pricing, USD per 1M tokens (api.anthropic.com list price, checked against the
// Anthropic pricing reference). Update these if the model or its pricing changes.
const PRICE_PER_MTOK_INPUT = 1.0;
const PRICE_PER_MTOK_OUTPUT = 5.0;

function estimateCostUsd({ inputTokens = 0, outputTokens = 0 } = {}) {
  return (inputTokens / 1e6) * PRICE_PER_MTOK_INPUT + (outputTokens / 1e6) * PRICE_PER_MTOK_OUTPUT;
}

function defaultInstruction(mode) {
  if (mode === 'forward') return 'Write a brief, friendly note introducing the forwarded message below.';
  if (mode === 'reply' || mode === 'reply-all') return 'Write a polite, concise reply to the message below.';
  return 'Write a short, professional email.';
}

function buildPrompt({ subject, quotedText, instruction, mode }) {
  const parts = [
    'You are drafting the body of an email in a desktop mail client. Reply with only the email body text — no subject line, no signature, no greeting like "Here is a draft", and no markdown formatting.',
    `Instruction: ${instruction || defaultInstruction(mode)}`
  ];
  if (subject) parts.push(`Subject: ${subject}`);
  if (quotedText && quotedText.trim()) {
    parts.push(`The message being ${mode === 'forward' ? 'forwarded' : 'replied to'}:\n"""\n${quotedText.slice(0, MAX_CONTEXT_CHARS)}\n"""`);
  }
  return parts.join('\n\n');
}

class AiService {
  constructor(store, { fetchImpl } = {}) {
    this.store = store;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
  }

  async draftReply({ subject, quotedText, instruction, mode }) {
    const apiKey = this.store.getAiKey();
    const prompt = buildPrompt({ subject, quotedText, instruction, mode });
    const res = await this.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (res.status === 401) throw new Error('Claude rejected the API key. Check it in Settings → AI.');
    if (!res.ok) throw new Error(`Claude API error (${res.status}).`);
    const data = await res.json();
    const text = (data.content || []).map(b => b.text || '').join('').trim();
    if (!text) throw new Error('Claude returned an empty draft.');
    const usage = {
      inputTokens: (data.usage && data.usage.input_tokens) || 0,
      outputTokens: (data.usage && data.usage.output_tokens) || 0
    };
    return { text, usage };
  }
}

module.exports = { AiService, MODEL, MAX_CONTEXT_CHARS, PRICE_PER_MTOK_INPUT, PRICE_PER_MTOK_OUTPUT, estimateCostUsd };
