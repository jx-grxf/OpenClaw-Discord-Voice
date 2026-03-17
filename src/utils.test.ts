import test from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from './utils.js';

test('truncate returns empty string for non-positive limits', () => {
  assert.equal(truncate('hello', 0), '');
  assert.equal(truncate('hello', -1), '');
});

test('truncate keeps single-character budget valid', () => {
  assert.equal(truncate('hello', 1), '…');
  assert.equal(truncate('h', 1), 'h');
});
