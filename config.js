// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MineAgent
/**
 * dsh-mc-connect — 行配置归一化。
 *
 * 本包是本地 link 安装的插件，profile 的 node_modules 里没有 DSH 包，
 * 所以不导出 `Config`（那需要 schemastery），而是在 `apply` 时手工校验。
 * 非法配置直接抛带字段名的中文错误，让整行不激活。
 *
 * @module dsh-mc-connect/config
 */

/** 各字段的默认值；两个 preset 行不写 config 时就是这一份。 */
export const DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:3420',
  eventHost: '127.0.0.1',
  eventPort: 3422,
  batchWindowMs: 500,
  maxBodyBytes: 1024 * 1024,
  luaCommand: 'lua',
});

/** 合并窗口上限（毫秒）。 */
const MAX_BATCH_WINDOW_MS = 60_000;

/** 请求体上限的配置下限 / 上限（字节）。 */
const MIN_BODY_BYTES = 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * 归一化游戏侧 HTTP 服务根地址：去空白、去末尾斜杠。
 * @param {unknown} value - 配置值。
 * @returns {string} 根地址。
 */
export function normalizeBaseUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const candidate = (text.length > 0 ? text : DEFAULTS.baseUrl).replace(/\/+$/, '');
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('dsh-mc-connect: baseUrl 必须是合法的 http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('dsh-mc-connect: baseUrl 必须是合法的 http(s) URL');
  }
  return candidate;
}

/**
 * 校验 http(s) URL。
 * @param {unknown} value - 配置值。
 * @param {string} fallback - 缺失时的默认值。
 * @param {string} field - 报错字段名。
 * @returns {string} 归一化后的 URL。
 */
function resolveHttpUrl(value, fallback, field) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0) return fallback;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`dsh-mc-connect: ${field} 必须是合法的 http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`dsh-mc-connect: ${field} 必须是合法的 http(s) URL`);
  }
  return url.href;
}

/**
 * 校验一个整数配置。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 缺失时的默认值。
 * @param {number} min - 允许的最小值。
 * @param {number} max - 允许的最大值。
 * @param {string} field - 报错字段名。
 * @returns {number} 归一化后的整数。
 */
export function integerInRange(value, fallback, min, max, field) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`dsh-mc-connect: ${field} 必须是 [${min}, ${max}] 内的整数`);
  }
  return number;
}

/**
 * 归一化一行 config。
 * @param {Record<string, unknown> | undefined} config - preset 行里的 config。
 * @returns {{ baseUrl: string, eventHost: string, eventPort: number, batchWindowMs: number, maxBodyBytes: number, luaCommand: string, catalogUrl: string }} 配置。
 */
export function resolveConfig(config) {
  const baseUrl = normalizeBaseUrl(config?.baseUrl);
  const rawHost = typeof config?.eventHost === 'string' ? config.eventHost.trim() : '';
  if (
    config?.luaCommand !== undefined &&
    config?.luaCommand !== null &&
    typeof config.luaCommand !== 'string'
  ) {
    throw new Error('dsh-mc-connect: luaCommand 必须是字符串');
  }
  const rawLuaCommand = typeof config?.luaCommand === 'string' ? config.luaCommand.trim() : '';
  return {
    baseUrl,
    eventHost: rawHost.length > 0 ? rawHost : DEFAULTS.eventHost,
    eventPort: integerInRange(config?.eventPort, DEFAULTS.eventPort, 0, 65_535, 'eventPort'),
    batchWindowMs: integerInRange(
      config?.batchWindowMs,
      DEFAULTS.batchWindowMs,
      0,
      MAX_BATCH_WINDOW_MS,
      'batchWindowMs',
    ),
    maxBodyBytes: integerInRange(
      config?.maxBodyBytes,
      DEFAULTS.maxBodyBytes,
      MIN_BODY_BYTES,
      MAX_BODY_BYTES,
      'maxBodyBytes',
    ),
    luaCommand: rawLuaCommand.length > 0 ? rawLuaCommand : DEFAULTS.luaCommand,
    catalogUrl: resolveHttpUrl(config?.catalogUrl, `${baseUrl}/evt/`, 'catalogUrl'),
  };
}

/**
 * 判断一个监听地址是否只对本机开放。
 * @param {string} host - 监听地址。
 * @returns {boolean} 是否是 loopback。
 */
export function isLoopbackHost(host) {
  return (
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('127.')
  );
}

/**
 * 显示给模型看的地址：通配地址换成本机回环地址。
 * @param {string} host - 实际监听地址。
 * @returns {string} 可用于访问的地址。
 */
export function displayHost(host) {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '::1';
  return host;
}

/**
 * 拼出 endpoint URL（IPv6 需要方括号）。
 * @param {string} host - 显示用地址。
 * @param {number} port - 实际端口。
 * @returns {string} 带尾斜杠的 URL。
 */
export function endpointFor(host, port) {
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${port}/`;
}
