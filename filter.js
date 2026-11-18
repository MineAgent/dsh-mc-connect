// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MineAgent
/**
 * MC 模式的工具面收口。
 *
 * Host 层在 DSH 0.2.x 里新增了 `@deepseek-ai/dsh-tool-working-directory`，
 * 而 preset 的子插件会继承 Host 全局层注册的工具，于是 `working_directory`
 * 也出现在了 MC 模式里。MC 模式的设计是「只留游戏控制与观测」，所以这个
 * 插件只在 MC 模式的 scope 里把该工具从继承面里遮掉。
 *
 * `tools.restrict` 只过滤「继承层」的工具，preset 自己挂载的
 * mc_*、subscribe_mc_event、todo_write、create_goal 等不受影响；本插件不挂进
 * 「MC 模式+」，那边继续拥有标准模式的完整工具面。
 *
 * @module dsh-mc-connect/filter
 */

/** Cordis 插件名，用于 Loader 诊断。 */
export const name = 'mc-connect-tool-filter';

/** 需要工具注册表存在后才能施加限制。 */
export const inject = ['tools'];

/** 从 MC 模式的继承工具面里移除的工具。 */
const HIDDEN = ['working_directory'];

/**
 * 在挂载它的 preset scope 上注册一条 deny 限制。
 *
 * `restrict()` 的 disposer 交给 `ctx.effect` 管理：mode 切换、bundle 重载或
 * profile 销毁时限制随之解除。Host 以后若删掉 `tool-working-directory`，
 * `restrict()` 会因为名字未知而抛错，这里静默跳过，避免一个可选的收口把
 * 整个 preset 弄挂。
 *
 * @param ctx - 提供 tools 服务的 preset scope 上下文。
 */
export function apply(ctx) {
  ctx.effect(() => {
    try {
      if (ctx.tools.get('working_directory') === undefined) return undefined;
      return ctx.tools.restrict({ deny: HIDDEN });
    } catch (error) {
      ctx.logger?.warn?.(
        'mc-connect-tool-filter: could not hide %s: %s',
        HIDDEN.join(', '),
        String(error),
      );
      return;
    }
  }, 'mc-connect-tool-filter: hide working_directory');
}
