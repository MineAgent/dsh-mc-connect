// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MineAgent
/**
 * dsh-mc-connect — preset 入口。
 *
 * 一个插件行同时提供：
 *  - 19 个 Minecraft 控制/观测工具（mc_*），直接 HTTP 调 127.0.0.1:3420；
 *  - 2 个事件工具（subscribe_mc_event / get_mc_event_types），监听 127.0.0.1:3422。
 *
 * 19 个 mc_* 只依赖 `tools`，所以先注册；事件工具还需要会话控制器与会话存储，
 * 用 `ctx.inject` 等它们齐了再注册到同一个 preset scope。这样某些组合缺事件
 * 服务时，游戏控制工具仍然可用。
 *
 * 界面路由不在这里注册：preset 子插件在独立 EntryTree 里，client-modules
 * 扫描不到；界面由根入口 `index.js` 在宿主全局挂载。
 *
 * @module dsh-mc-connect/tools
 */

import { registerBridgeTools } from './bridge.js';
import { resolveConfig } from './config.js';
import { registerEventTools } from './events.js';

/** Cordis 插件名。 */
export const name = 'mc-connect-tools';

/** 先要工具注册表；事件工具的四项服务在 apply 内部再等。 */
export const inject = ['tools'];

/**
 * 注册全部 MC 工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx - preset scope 上下文。
 * @param {Record<string, unknown>} [config] - preset 行里的 config。
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);

  ctx.effect(() => {
    const disposeBridge = registerBridgeTools(ctx, resolved);
    return () => {
      disposeBridge();
    };
  }, 'dsh-mc-connect: bridge tools');

  ctx.inject(['sessionController', 'sessions', 'agents'], (eventCtx) => {
    eventCtx.effect(() => {
      const disposeEvents = registerEventTools(eventCtx, resolved);
      return () => {
        disposeEvents();
      };
    }, 'dsh-mc-connect: event tools');
  });
}
