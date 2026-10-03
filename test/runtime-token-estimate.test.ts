import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens } from '../src/runtime/index.js';

test('estimateTokens counts ASCII quarters and non-ASCII code points', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens('Kian 你好'), 4);
  assert.equal(estimateTokens('\u{1F600}'), 1);
  assert.equal(estimateTokens('\ud83d'), 1);
  assert.equal(estimateTokens('海'.repeat(60_000)), 60_000);
});
