import test from 'node:test';
import assert from 'node:assert/strict';
import { collectBridgeHealth, summarizeHealthIssues } from './diagnostics.js';

test('collectBridgeHealth reports missing env vars from provided env', () => {
  const health = collectBridgeHealth({});
  const issues = summarizeHealthIssues(health);

  assert(issues.some((issue) => issue.startsWith('DISCORD_TOKEN:')));
  assert(issues.some((issue) => issue.startsWith('DISCORD_GUILD_ID:')));
});

test('collectBridgeHealth does not require optional discord receive user override', () => {
  const health = collectBridgeHealth({
    DISCORD_TOKEN: 'token',
    DISCORD_GUILD_ID: 'guild',
  });
  const issues = summarizeHealthIssues(health);

  assert.equal(issues.some((issue) => issue.startsWith('DISCORD_USER_ID:')), false);
});

test('collectBridgeHealth requires ElevenLabs credentials when provider is elevenlabs', () => {
  const health = collectBridgeHealth({
    DISCORD_TOKEN: 'token',
    DISCORD_GUILD_ID: 'guild',
    TTS_PROVIDER: 'elevenlabs',
  });
  const issues = summarizeHealthIssues(health);

  assert(issues.some((issue) => issue.startsWith('ELEVENLABS_API_KEY:')));
  assert(issues.some((issue) => issue.startsWith('ELEVENLABS_VOICE_ID:')));
  assert.equal(issues.some((issue) => issue.startsWith('say:')), false);
});
