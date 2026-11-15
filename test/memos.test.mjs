import test from 'node:test';
import assert from 'node:assert/strict';
import { linkify, resolveAnchor } from '../src/layout/memos.js';

test('web addresses become links, with https:// added to www addresses', () => {
  assert.deepEqual(linkify('참고: https://arxiv.org/abs/2611.08654, 그리고 www.example.com/a?b=1.'), [
    { text: '참고: ' },
    { text: 'https://arxiv.org/abs/2611.08654', href: 'https://arxiv.org/abs/2611.08654' },
    { text: ', 그리고 ' },
    { text: 'www.example.com/a?b=1', href: 'https://www.example.com/a?b=1' },
    { text: '.' },
  ]);
});

test('text without a usable address stays plain', () => {
  assert.deepEqual(linkify('http:// 만 쓰거나 www. 만 쓴 경우, javascript:alert(1)'), [{ text: 'http:// 만 쓰거나 www. 만 쓴 경우, javascript:alert(1)' }]);
  assert.deepEqual(linkify(''), []);
});

const memo = (members, anchor) => ({ members, anchor });

test('an anchor keeps its sentences while their text is unchanged', () => {
  assert.deepEqual(resolveAnchor(memo([1, 2], 'B. C.'), ['A.', 'B.', 'C.']), [1, 2]);
});

test('an anchor is found again by text when sentence numbering shifted', () => {
  assert.deepEqual(resolveAnchor(memo([1, 2], 'B. C.'), ['New.', 'A.', 'B.', 'C.']), [2, 3]);
  assert.deepEqual(resolveAnchor(memo([7], 'C.'), ['A.', 'B.', 'C.']), [2]);
});

test('an anchor whose text left the page is reported as missing', () => {
  assert.equal(resolveAnchor(memo([1], 'Gone.'), ['A.', 'B.']), null);
  assert.equal(resolveAnchor(memo([0], 'A. B. C.'), ['A.', 'B.']), null);
});
