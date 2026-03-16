import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenClawAgentParams,
  buildOpenClawSessionDeleteParams,
  buildOpenClawSessionResetParams,
  extractOpenClawReply,
  extractOpenClawSessionId,
  extractOpenClawSessionKey,
} from './openclaw.js';

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
      sessionKey: 'agent:main:discord:voice:guild:guild-1:channel:channel-1:join:test',
    },
  });

  assert.equal(extractOpenClawSessionId(raw), 'oc-session-123');
  assert.equal(extractOpenClawSessionKey(raw), 'agent:main:discord:voice:guild:guild-1:channel:channel-1:join:test');
});

test('buildOpenClawAgentParams targets the stable session key and optional session id', () => {
  const params = buildOpenClawAgentParams('Hello there', {
    sessionKey: 'agent:main:discord:voice:guild:guild-1:channel:channel-1:join:test',
    sessionId: 'oc-session-123',
  });

  assert.equal(typeof params.idempotencyKey, 'string');
  assert.equal(String(params.idempotencyKey).startsWith('discord-voice-'), true);
  assert.equal(params.message, 'Hello there');
  assert.equal(params.sessionKey, 'agent:main:discord:voice:guild:guild-1:channel:channel-1:join:test');
  assert.equal(params.sessionId, 'oc-session-123');
  assert.equal(params.thinking, 'off');
});

test('buildOpenClawSessionResetParams creates a new gateway reset request', () => {
  const params = buildOpenClawSessionResetParams('agent:main:discord:voice:guild:guild-1:channel:channel-1:join:test');

  assert.deepEqual(params, {
    key: 'agent:main:discord:voice:guild:guild-1:channel:channel-1:join:test',
    reason: 'new',
  });
});

test('buildOpenClawSessionDeleteParams creates a delete request with transcript cleanup', () => {
  const params = buildOpenClawSessionDeleteParams('agent:main:discord:voice:guild:guild-1:channel:channel-1:join:test');

  assert.deepEqual(params, {
    key: 'agent:main:discord:voice:guild:guild-1:channel:channel-1:join:test',
    deleteTranscript: true,
  });
});
