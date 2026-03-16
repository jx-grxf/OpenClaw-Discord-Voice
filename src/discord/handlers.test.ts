import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReceiveUserId } from './handlers.js';

test('resolveReceiveUserId prefers configured Discord user override', () => {
  assert.equal(resolveReceiveUserId('interaction-user', 'configured-user'), 'configured-user');
});

test('resolveReceiveUserId falls back to the interaction user when no override is set', () => {
  assert.equal(resolveReceiveUserId('interaction-user', ''), 'interaction-user');
  assert.equal(resolveReceiveUserId('interaction-user', undefined), 'interaction-user');
});
