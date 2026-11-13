import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranslatedSegments } from '../src/layout/stream.js';

const parse = (text, sources, isFinal = true) => parseTranslatedSegments(text, sources, isFinal).segments.map((s) => [s.members[0], s.text]);
const SOURCES = ['A', 'B', 'C'];

test('a repeated marker keeps the page translated', () => {
  assert.deepEqual(parse('<|0|>가\n<|1\n<|1|>나\n<|2|>다', SOURCES), [
    [0, '가'],
    [1, '나'],
    [2, '다'],
  ]);
});

test('out-of-order and out-of-range markers are ignored without leaking their text', () => {
  assert.deepEqual(parse('<|0|>가\n<|2|>다\n<|1|>나\n<|9|>z', SOURCES), [
    [0, '가'],
    [2, '다'],
  ]);
});

test('a stray marker fragment inside a cached translation is stripped', () => {
  assert.deepEqual(parse('<|0|>가.\n<|4\n<|1|>나', SOURCES.slice(0, 2)), [
    [0, '가.'],
    [1, '나'],
  ]);
});

test('the last segment waits for the next marker until the stream is final', () => {
  assert.deepEqual(parse('<|0|>가\n<|1|>나', SOURCES, false), [[0, '가']]);
});
