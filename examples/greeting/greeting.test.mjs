import assert from 'node:assert/strict';
import test from 'node:test';
import { greet } from './greeting.mjs';

test('greeting supplies a named or default greeting', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!');
  assert.equal(greet(), 'Hello, world!');
});
