/**
 * dsh-mc-connect preset 入口的接线测试。
 *
 * 用假 Context 验证 tools.js 同时注册 14 个 mc_* 与 2 个事件工具，
 * 且非法配置在 apply 时直接抛错。
 *
 *   node --test test/tools.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../tools.js';

/**
 * 造一个接近 Cordis 形状的假 Context。
 * @param {object} [options] - 是否提供事件服务。
 * @returns {object} ctx 与注册表。
 */
function fakeContext(options = {}) {
  const tools = new Map();
  const effects = [];
  const listeners = new Map();
  const services = {
    sessionController: { async resolveAgent() { return { error: { message: 'none' } }; } },
    sessions: { get() { return undefined; }, async flush() {} },
    agents: { get() { return undefined; }, list() { return []; } },
  };
  if (options.events === false) delete services.sessionController;
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    effect(callback) {
      effects.push(callback());
    },
    inject(names, callback) {
      if (names.every((name) => services[name] !== undefined)) callback(ctx);
      return () => {};
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {};
    },
    get(name) {
      return services[name];
    },
  };
  return { ctx, tools, listeners };
}

test('一个 preset 行同时注册 14 个 mc_* 与 2 个事件工具', () => {
  const { ctx, tools } = fakeContext();
  apply(ctx, {});
  assert.equal(tools.size, 16);
  for (const name of [
    'mc_status',
    'mc_player',
    'mc_control',
    'mc_screenshot',
    'mc_request',
    'subscribe_mc_event',
    'get_mc_event_types',
  ]) {
    assert.equal(tools.has(name), true, `missing ${name}`);
  }
});

test('事件服务缺失时仍注册 14 个 mc_*', () => {
  const { ctx, tools } = fakeContext({ events: false });
  apply(ctx, {});
  assert.equal(tools.size, 14);
  assert.equal(tools.has('subscribe_mc_event'), false);
  assert.equal(tools.has('mc_status'), true);
});

test('非法配置在 apply 时抛中文错误', () => {
  const { ctx } = fakeContext();
  assert.throws(() => apply(ctx, { baseUrl: 'ftp://x' }), /baseUrl/);
  assert.throws(() => apply(ctx, { eventPort: 70_000 }), /eventPort/);
});
