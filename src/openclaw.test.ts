import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOpenClawReply, extractOpenClawSessionId, extractOpenClawSessionKey } from './openclaw.js';

test('extractOpenClawReply prefers structured outputText', () => {
  const raw = JSON.stringify({
    result: {
      outputText: 'Hello from OpenClaw',
      payloads: [{ text: 'Fallback' }],
    },
  });

  assert.equal(extractOpenClawReply(raw), 'Hello from OpenClaw');
});

test('extractOpenClawReply falls back to payload text or summary', () => {
  const raw = JSON.stringify({
    result: {
      payloads: [{ text: '' }, { content: 'Reply from payload' }],
      meta: { summaryText: 'Summary reply' },
    },
  });

  assert.equal(extractOpenClawReply(raw), 'Reply from payload');
});

test('extractOpenClawReply returns raw text when input is not json', () => {
  assert.equal(extractOpenClawReply('Direct reply'), 'Direct reply');
});

test('extractOpenClawSession metadata when available', () => {
  const raw = JSON.stringify({
    result: {
      outputText: 'Hello',
      sessionId: 'oc-session-123',
      sessionKey: 'discord-voice-guild-user',
    },
  });

  assert.equal(extractOpenClawSessionId(raw), 'oc-session-123');
  assert.equal(extractOpenClawSessionKey(raw), 'discord-voice-guild-user');
});
