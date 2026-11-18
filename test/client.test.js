/**
 * dsh-mc-connect 浏览器端的接线测试。
 *
 * 在 vm 里执行手写的 __ModuleLoader__ 产物，确认模块 id 与包名一致，
 * 且 apply 会注册 composer dock 与设置页两个 slot。
 *
 *   node --test test/client.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/**
 * 执行 client.js 并返回注册的模块。
 * @returns {{ id: string, exports: object, slotNames: string[] }} 模块信息。
 */
function loadClient() {
  let loaded;
  const window = {
    __ModuleLoader__: {
      load(entry) {
        loaded = entry;
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const context = {
    window,
    document: { hidden: true },
    navigator: { language: 'zh-CN' },
    console,
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    fetch: async () => ({
      ok: true,
      async json() {
        return { enabled: true, listening: false, subscriptions: [] };
      },
    }),
    Promise,
    JSON,
    Object,
    Array,
    String,
    Number,
  };
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), context);
  assert.ok(loaded, 'client.js must call window.__ModuleLoader__.load');
  const react = {
    createElement: () => null,
    useState: (value) => [value, () => {}],
    useEffect: () => {},
  };
  const exports = loaded.factory((name) => {
    if (name === 'react') return react;
    throw new Error(`unexpected require ${name}`);
  });
  return { id: loaded.id, exports, react };
}

test('client 模块 id 等于包名，并注册两个 slot', () => {
  const { id, exports } = loadClient();
  assert.equal(id, 'dsh-mc-connect');
  assert.equal(exports.name, 'mc-connect');
  assert.deepEqual(Array.from(exports.inject), ['slots', 'locale']);

  const slots = [];
  const ctx = {
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    locale: {
      getSnapshot: () => ({ active: 'zh' }),
      register: () => () => {},
    },
    slots: {
      inject(name, callback) {
        callback();
        return () => {};
      },
      register(options) {
        slots.push(options);
        return () => {};
      },
    },
  };
  exports.apply(ctx);
  assert.deepEqual(
    slots.map((row) => [row.name, row.id]),
    [
      ['conversation.composer.dock', 'mc-connect-listener'],
      ['settings.section', 'mc-connect'],
    ],
  );
});
