import test from 'node:test';
import assert from 'node:assert/strict';
import { getOrCreateVoiceSession, getVoiceSession, markVoiceSessionUsed } from './state.js';

test('getOrCreateVoiceSession creates a stable per-user key', () => {
  const first = getOrCreateVoiceSession('guild-1', 'user-1');
  const second = getOrCreateVoiceSession('guild-1', 'user-1');

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.session.sessionKey, 'discord-voice-guild-1-user-1');
  assert.equal(second.session.sessionKey, 'discord-voice-guild-1-user-1');
});

test('markVoiceSessionUsed stores OpenClaw session details after a real turn', () => {
  getOrCreateVoiceSession('guild-2', 'user-2');
  const updated = markVoiceSessionUsed('user-2', {
    initialized: true,
    sessionKey: 'discord-voice-canonical',
    openClawSessionId: 'oc-session-456',
  });

  assert(updated);
  assert.equal(updated?.sessionKey, 'discord-voice-canonical');
  assert.equal(updated?.openClawSessionId, 'oc-session-456');
  assert.equal(Boolean(updated?.initializedAt), true);
  assert.equal(Boolean(updated?.lastUsedAt), true);
  assert.equal(getVoiceSession('user-2')?.openClawSessionId, 'oc-session-456');
});
