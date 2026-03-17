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
