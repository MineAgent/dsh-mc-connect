/**
 * dsh-mc-connect 的 MC 模式收口测试。
 *
 *   node --test test/filter.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../filter.js';

/**
 * 造一个只提供 tools 的假 Context。
 * @returns {object} ctx 与记录。
 */
function fakeContext() {
  const restricted = [];
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: {
      restrict(filter) {
        restricted.push(filter);
        return () => {};
      },
    },
    effect(callback) {
      effects.push(callback());
    },
  };
  return { ctx, restricted, effects };
}

test('MC 模式用空 allow 白名单遮掉全部继承工具', () => {
  const { ctx, restricted } = fakeContext();
  apply(ctx);
  assert.deepEqual(restricted, [{ allow: [] }]);
});
