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
 * @param {object} [options] - 是否注册 working_directory。
 * @returns {object} ctx 与记录。
 */
function fakeContext(options = {}) {
  const restricted = [];
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: {
      get(name) {
        if (options.hasWorkingDirectory === false) return undefined;
        return name === 'working_directory' ? { name } : undefined;
      },
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

test('working_directory 存在时在 MC 模式 scope 上 deny 掉', () => {
  const { ctx, restricted } = fakeContext();
  apply(ctx);
  assert.deepEqual(restricted, [{ deny: ['working_directory'] }]);
});

test('working_directory 不存在时静默跳过', () => {
  const { ctx, restricted } = fakeContext({ hasWorkingDirectory: false });
  apply(ctx);
  assert.deepEqual(restricted, []);
});
