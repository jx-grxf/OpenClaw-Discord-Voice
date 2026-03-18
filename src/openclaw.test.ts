import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenClawAgentParams,
  buildOpenClawSessionDeleteParams,
  buildOpenClawSessionResetParams,
  deleteOpenClawSession,
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

test('extractOpenClawReply falls back to summary when no final outputText exists', () => {
  const raw = JSON.stringify({
    result: {
      payloads: [{ text: '' }, { content: 'Reply from payload' }],
      meta: { summaryText: 'Summary reply' },
    },
  });

  assert.equal(extractOpenClawReply(raw), 'Summary reply');
});

test('extractOpenClawReply joins meaningful payload text when tools emit interim and final text', () => {
  const raw = JSON.stringify({
    result: {
      payloads: [
        { text: 'Ich schaue kurz nach.' },
        { content: '' },
        { content: 'Finale Antwort mit den echten Ergebnissen.' },
      ],
    },
  });

  assert.equal(extractOpenClawReply(raw), 'Ich schaue kurz nach.\n\nFinale Antwort mit den echten Ergebnissen.');
});

test('extractOpenClawReply still prefers summary over payload chatter when available', () => {
  const raw = JSON.stringify({
    result: {
      payloads: [
        { text: 'Ich prüfe das kurz.' },
        { content: 'Noch ein Zwischenstand.' },
      ],
      meta: { summaryText: 'Zusammenfassung mit finaler Antwort.' },
    },
  });

  assert.equal(extractOpenClawReply(raw), 'Zusammenfassung mit finaler Antwort.');
});

test('extractOpenClawReply ignores completed placeholder text and uses payloads instead', () => {
  const raw = JSON.stringify({
    summary: 'completed',
    text: 'completed',
    result: {
      text: 'completed',
      payloads: [{ text: 'Die echte finale Antwort.' }],
    },
  });

  assert.equal(extractOpenClawReply(raw), 'Die echte finale Antwort.');
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

test('deleteOpenClawSession export remains callable', () => {
  assert.equal(typeof deleteOpenClawSession, 'function');
});
