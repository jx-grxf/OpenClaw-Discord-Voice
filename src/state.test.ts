import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginGuildJoin,
  beginGuildListen,
  buildVoiceSessionKey,
  clearVoiceSession,
  createVoiceSession,
  endGuildJoin,
  endGuildListen,
  getActiveGuildJoinUser,
  getActiveGuildListenUser,
  getVoiceSession,
  markVoiceSessionUsed,
} from './state.js';

test('buildVoiceSessionKey creates a guild-channel scoped ephemeral key', () => {
  const key = buildVoiceSessionKey('guild-1', 'channel-1');

  assert.match(key, /^agent:main:discord:voice:guild:guild-1:channel:channel-1:join:/);
});

test('createVoiceSession stores one active session per guild', () => {
  const created = createVoiceSession('guild-1', 'channel-1', 'user-1', {
    sessionKey: 'agent:main:discord:voice:guild:guild-1:channel:channel-1:join:test',
    openClawSessionId: 'oc-session-1',
  });

  assert.equal(created.channelId, 'channel-1');
  assert.equal(created.createdByUserId, 'user-1');
  assert.equal(getVoiceSession('guild-1')?.openClawSessionId, 'oc-session-1');

  clearVoiceSession('guild-1');
});

test('markVoiceSessionUsed stores OpenClaw session details after a real turn', () => {
  createVoiceSession('guild-2', 'channel-2', 'user-2');
  const updated = markVoiceSessionUsed('guild-2', {
    initialized: true,
    sessionKey: 'agent:main:discord:voice:guild:guild-2:channel:channel-2:join:canonical',
    openClawSessionId: 'oc-session-456',
  });

  assert(updated);
  assert.equal(updated?.sessionKey, 'agent:main:discord:voice:guild:guild-2:channel:channel-2:join:canonical');
  assert.equal(updated?.openClawSessionId, 'oc-session-456');
  assert.equal(Boolean(updated?.initializedAt), true);
  assert.equal(Boolean(updated?.lastUsedAt), true);

  clearVoiceSession('guild-2');
});

test('clearVoiceSession removes the active guild session', () => {
  createVoiceSession('guild-3', 'channel-3', 'user-3');

  const cleared = clearVoiceSession('guild-3');

  assert(cleared);
  assert.equal(getVoiceSession('guild-3'), null);
});

test('guild listen lock blocks parallel listeners from other users', () => {
  const first = beginGuildListen('guild-lock', 'user-a');
  const second = beginGuildListen('guild-lock', 'user-b');

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.activeUserId, 'user-a');
  assert.equal(getActiveGuildListenUser('guild-lock'), 'user-a');

  endGuildListen('guild-lock', 'user-a');
  assert.equal(getActiveGuildListenUser('guild-lock'), null);
});

test('guild listen lock also blocks re-entrant listens from the same user', () => {
  const first = beginGuildListen('guild-lock-same-user', 'user-a');
  const second = beginGuildListen('guild-lock-same-user', 'user-a');

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.activeUserId, 'user-a');

  endGuildListen('guild-lock-same-user', 'user-a');
  assert.equal(getActiveGuildListenUser('guild-lock-same-user'), null);
});

test('guild join lock blocks concurrent setup attempts', () => {
  const first = beginGuildJoin('guild-join-lock', 'user-a');
  const second = beginGuildJoin('guild-join-lock', 'user-b');

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.activeUserId, 'user-a');
  assert.equal(getActiveGuildJoinUser('guild-join-lock'), 'user-a');

  endGuildJoin('guild-join-lock', 'user-a');
  assert.equal(getActiveGuildJoinUser('guild-join-lock'), null);
});
