import test from 'node:test';
import assert from 'node:assert/strict';
import { buildListenLogDetails, handleJoin, redactSessionKey } from './handlers.js';

test('handlers module exports join handler', () => {
  assert.equal(typeof handleJoin, 'function');
});

test('redactSessionKey keeps only a short preview for logs', () => {
  assert.equal(redactSessionKey('agent:main:discord:voice:guild:123:channel:456:join:abcdef'), 'agent:main:discord:voic…');
});

test('buildListenLogDetails redacts identifiers and keeps only coarse runtime state', () => {
  const details = buildListenLogDetails({
    guildId: 'guild-1',
    channelId: 'channel-1',
    speakingStarted: true,
    ssrcMapped: false,
    opusPackets: 12,
    transcriptLength: 34,
    hasOpenClawSessionId: true,
    sessionKey: 'agent:main:discord:voice:guild:123:channel:456:join:abcdef',
  });

  assert.deepEqual(details, {
    guildId: 'guild-1',
    channelId: 'channel-1',
    speakingStarted: true,
    ssrcMapped: false,
    opusPackets: 12,
    opusBytes: undefined,
    pcmBytes: undefined,
    transcriptLength: 34,
    hasOpenClawSessionId: true,
    sessionKeyPreview: 'agent:main:discord:voic…',
  });
  assert.equal('receiveUserId' in details, false);
});
