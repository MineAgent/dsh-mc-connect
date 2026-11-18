// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MineAgent
/**
 * dsh-mc-connect — 宿主全局入口。
 *
 * 这个包同时承载 MC 模式的两个 preset 和浏览器端界面。preset 里的工具由
 * `dsh-mc-connect/tools` 挂载；界面必须由一个**主 Loader 的裸包名条目**承载，
 * 因为 client-modules 只扫描主 Loader 条目，而 preset 子插件在独立 EntryTree 里。
 * 所以根包（`dsh-mc-connect`）挂在宿主全局，只注册 `/api/dsh-mc-connect/*`
 * 状态路由与客户端 bundle，不注册任何模型工具。
 *
 * @module dsh-mc-connect
 */

import { applyUi } from './events.js';

/** Cordis 插件名。 */
export const name = 'mc-connect-ui';

/**
 * 注册界面状态路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主全局上下文。
 */
export function apply(ctx) {
  applyUi(ctx);
}
