import test from 'node:test';
import assert from 'node:assert/strict';
import { handleJoin } from './handlers.js';

test('handlers module exports join handler', () => {
  assert.equal(typeof handleJoin, 'function');
});
