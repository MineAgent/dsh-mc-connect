// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MineAgent
/**
 * MC 模式的工具面收口。
 *
 * preset 的子插件会继承 Host 全局层注册的工具；MC 模式的设计是「只留游戏
 * 控制与观测」，所以这里用空 allow 白名单把**所有继承来的宿主工具**遮掉。
 * 以后 profile 里新装插件注册的宿主工具也不会漏进 MC 模式。
 *
 * `tools.restrict` 只过滤「继承层」的工具，preset 自己挂载的
 * mc_*、subscribe_mc_event、ask_user_question 等不受影响；本插件不挂进
 * 「MC 模式+」，那边继续拥有标准模式的完整工具面。
 *
 * @module dsh-mc-connect/filter
 */

/** Cordis 插件名，用于 Loader 诊断。 */
export const name = 'mc-connect-tool-filter';

/** 需要工具注册表存在后才能施加限制。 */
export const inject = ['tools'];

/**
 * 在挂载它的 preset scope 上注册一条空 allow 限制。
 *
 * `allow: []` 表示继承层一个工具都不保留；preset 自己注册的 scoped 工具不受
 * 影响。`restrict()` 的 disposer 交给 `ctx.effect` 管理：mode 切换、bundle
 * 重载或 profile 销毁时限制随之解除。
 *
 * @param ctx - 提供 tools 服务的 preset scope 上下文。
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.tools.restrict({ allow: [] }),
    'mc-connect-tool-filter: hide all inherited host tools',
  );
}
