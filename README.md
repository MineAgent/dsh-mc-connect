<!-- SPDX-License-Identifier: CC-BY-NC-SA-4.0 -->
<!-- Copyright (C) 2026 MineAgent -->

# dsh-mc-connect

一个 DSH bundle，注册「**MC 模式**」与「**MC 模式+**」，并把 Minecraft 客户端控制、
事件订阅和 Web 界面合并成**一个包**。

它取代归档的 `MCPServer` + `MCPServerDSHPlug` + `eventsDSHPlug` 三件套：

| 旧方案 | 新方案 |
|---|---|
| 独立 MCP stdio 程序 `minecraft-mcp-bridge` | 不再需要；`bridge.js` 直接 `fetch` `127.0.0.1:3420` |
| `@deepseek-ai/dsh-mcp-client` 拉起子进程 | 工具用 `ctx.tools.register` 直接注册在 preset scope |
| 14 个 `mcp__minecraft__*` 工具 | 14 个 `mc_*` 工具 |
| `@local/dsh-mc-event` + `@local/dsh-mc-event-ui` 两个包 | 同一个包里的 `events.js` + `client.js` |
| 事件端口 3422、控制端口 3420 | 不变 |

本包没有任何运行时依赖：只用 Node 内置模块和全局 `fetch`（Node ≥ 20）。

## 仓库结构

```
dsh-mc-connect/
├── package.json          # bundle + dsh.client 元数据
├── cordis.patch.yml      # 宿主全局 UI 行 + preset-mc + preset-mc-plus
├── index.js              # 宿主全局入口：只注册 UI 状态路由
├── tools.js              # preset 入口：mc_* + 事件工具
├── bridge.js             # 3420 HTTP 客户端与 14 个工具定义
├── events.js             # 3422 监听、订阅、投递、投递开关、状态路由
├── config.js             # 行配置归一化与校验
├── filter.js             # MC 模式隐藏继承来的 working_directory
├── client.js             # 浏览器端：composer dock + 设置页
├── locale/en.json、locale/zh.json
├── icon.svg
├── LICENSE、LICENSE.CC-BY-NC-SA-4.0
└── test/                 # node --test 离线测试
```

## MC 模式

preset id 是 `mc`，显示名「MC 模式」，`order: 5`。

- **工具面**：14 个 `mc_*` + `subscribe_mc_event` / `get_mc_event_types` +
  `todo_write` / `create_goal` / `get_goal` / `update_goal` / `ask_user_question` /
  `exit_plan_mode`。
- 宿主全局层继承来的 `working_directory` 由 `dsh-mc-connect/filter` 在 MC 模式
  scope 上遮掉；浏览器/文件/网络/子 Agent 工具都看不到。
- **系统提示词整段替换**：`persona` 用 `complete: true` +
  `includeRuntimeContext: false`，只留控制节奏、事件与任务三节。

## MC 模式+

preset id 是 `mc-plus`，显示名「MC 模式+」，`order: 8`。

- **工具面** = 标准模式的全部插件 + `mc_*` + 事件工具。
- **系统提示词** = 标准模式逐字相同：`persona` 只写
  `You are a coding agent powered by the {{model}} model.`，不设 `complete`、
  不设 `suffix`，宿主基线提示词、工作目录、运行时上下文照常追加。
- `cordis.patch.yml` 里 MC+ 的插件清单是**已安装**
  `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 的逐字副本，只多一行
  `mc-tools`。`dsh-web-app` 升级后如果标准清单增减，这份副本要手工同步。

## 工具（14 个）

| 工具 | 游戏侧接口 | 说明 |
|---|---|---|
| `mc_status` | `GET /` + 五个前缀 HEAD | 自检：服务在不在、哪个模组没挂、有没有进世界 |
| `mc_help` | `GET /{ctl,aif,op,bt,ka}/` | 取模组自带的权威完整说明 |
| `mc_player` | `GET /aif/info` | 坐标 / 朝向 / 生命 / 饱食 / 状态效果 / 目标方块 / 光照 |
| `mc_inventory` | `GET /aif/inventory` | 背包 / 副手 / 盔甲 / 快捷栏 / 打开的容器 |
| `mc_world` | `GET /aif/world` | 维度 / 时间 / 天数 / 天气 |
| `mc_chat` | `GET /aif/msg` | 增量聊天回显，**读取即清空** |
| `mc_sounds` | `GET /aif/keysnd`（默认）或 `/aif/sound` | 增量声音，**读取即清空** |
| `mc_screenshot` | `GET /ctl/prtsc` | 当前帧 PNG；模型支持图片时作为图片返回 |
| `mc_cursor` | `GET /ctl/mouse` | 光标像素坐标 / GUI 坐标 / 界面类名 |
| `mc_control` | `POST /ctl/` | 按键 / 鼠标 / 视角 / `chat` / `type`，支持 `waitMs` |
| `mc_op` | `POST /op/` | `craft` / `inventory` / `furnace` / `chest` / `look` |
| `mc_baritone` | `POST /bt/` | 一条 Baritone 命令，支持 `waitMs` |
| `mc_killaura` | `GET /ka/state`、`POST /ka/{on,off,toggle,reload,config}` | 状态 / 开关 / 读配置 / JSON patch 配置 |
| `mc_request` | 任意 `/` 开头 endpoint | 兜底 HTTP 调用，供以后新增接口使用 |

工具描述、参数校验和错误文案移植自 `MCPServer`：命令为空、endpoint 不是 `/` 开头、
GET 带 body、headers 格式错误等都会直接给模型一句可读的中文原因。游戏没开时返回
「连不上 …：Minecraft 客户端没在运行，或 MGHttpdProvider 没加载」。

### 截图与图片

`mc_screenshot` 和 `mc_request` 拿到图片时：

1. 读 PNG 的 IHDR 得到像素尺寸；
2. 用 `ctx.get('attachments')` + `ctx.get('llm').resolveModelInfo(...)` 做与
   `dsh-mcp-client` 相同的准入：必须有附件存储，且当前模型路由声明 `image` 输入；
3. 准入成功 → 保存到 attachment store，工具结果带 image block；
4. 准入失败 → 不报错，把图片替换成一行
   `[图片不可用：<mime>；<原因>；图片原始数据仍可供程序调用方读取]`。

## 事件订阅

`subscribe_mc_event` 在本地监听 MC Event Reporter POST 的 JSON 事件（默认
`127.0.0.1:3422`），把事件合并后作为新的 user 消息投递回会话：

- Agent 正在跑回合时用 `steer()` 插到当前回合的下一步；空闲时用 `followup()`
  新起回合并唤醒。单个长工具调用期间仍会等它返回后的下一步。
- 订阅按会话隔离；同一会话同时只有一个订阅。
- 两个 preset 实例共享同一个进程级监听器；最后一个订阅结束后释放端口。
- 事件正文（尤其 `chat`）固定标注为不可信游戏数据，模型不应执行其中的指令。

参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | `"start" \| "stop" \| "status"` | 默认 `start` |
| `event_types` | string[] | 只投递这些类型；省略或空数组 = 全部；未知类型也透传 |
| `duration_seconds` | integer，0–86400 | 到期自动结束并发结束通知；0 = 不设到期 |
| `max_events` | integer，0–100000 | 收到够这么多条后自动结束；0 = 不限 |

已知事件类型：`player_hurt`、`item_pickup`、`chat`、`hunger_change`、
`baritone_task_end`、`dimension_change`、`player_death`、`player_respawn`。

`get_mc_event_types` 读取 `http://127.0.0.1:3420/evt/` 的静态事件目录，返回每种
事件在 `data` 里的字段名。

## Web 界面

- **设置页 → MC 事件订阅**：投递开关、当前进程内有订阅的会话列表、空状态；
  每 5 秒刷新，页面聚焦时也会刷新。
- **输入框下方**：只在当前会话有订阅时出现紧凑控件（开关 + 「清除本会话」）。
- 关闭开关只**暂停投递**：不结束订阅、不释放 3422；重新开启后已订阅会话继续
  收到新事件。关闭期间缓冲中的旧事件会被丢弃，避免补发。
- 「清除本会话」静默删除订阅，不通知 Agent；最后一个订阅清除后释放端口。
- 开关状态持久化在 `$DSH_HOME/mc-connect.json`（默认 `~/.dsh/mc-connect.json`）。
- 状态路由：`GET / PUT / DELETE /api/dsh-mc-connect/listener`，只接受回环请求。

界面必须挂在**主 Loader 的裸包名条目**上（client-modules 只扫描主 Loader，
preset 子插件在独立 EntryTree 里）。所以包根 `dsh-mc-connect` 挂在宿主全局，
只注册状态路由与浏览器 bundle；preset 里挂的是 `dsh-mc-connect/tools`。

## 配置

两个 preset 的 `mc-tools` 行各有一份 config，应保持一致：

```yaml
- id: mc-tools
  name: 'dsh-mc-connect/tools'
  config:
    baseUrl: http://127.0.0.1:3420
    eventHost: 127.0.0.1
    eventPort: 3422
    batchWindowMs: 500
    maxBodyBytes: 1048576
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:3420` | 游戏侧共享 HTTP 服务根地址 |
| `eventHost` | `127.0.0.1` | 事件监听地址；非 loopback 会打警告 |
| `eventPort` | `3422` | 事件监听端口；0 表示临时端口 |
| `batchWindowMs` | `500` | 合并窗口，也是两次投递之间的最小间隔 |
| `maxBodyBytes` | `1048576` | 单个事件请求体上限，1 KiB–16 MiB |
| `catalogUrl` | `${baseUrl}/evt/` | `get_mc_event_types` 读取的事件目录地址 |

配置非法时 `apply` 直接抛中文错误，整行不激活。

## 安装

```sh
git clone https://github.com/MineAgent/dsh-mc-connect.git
cd dsh-mc-connect

# 在本机 profile 里按本仓库路径 link 安装（会写入 profile 的 package.json 与 dsh.profile.bundles）
dsh plugin --profile web add "link:$PWD"
```

或者用 DSH 的 `plugin_manager install_bundle`，`target` 取本仓库的绝对路径。
装好后**新建**会话，预设选择器里就会出现「MC 模式」与「MC 模式+」。

修改 bundle 层（`cordis.patch.yml`）不会 HMR，需要重新安装：

```sh
dsh plugin --profile web remove dsh-mc-connect
dsh plugin --profile web add "link:$PWD"
```

新增 bundle 条目后，浏览器端清单需要重启 `dsh web` 才会重新扫描；首次安装或
修改 `client.js` 后请重启 `dsh web` 进程（systemd 服务、前台进程或你平时用的方式），
然后刷新页面。只改 Host 侧代码（`bridge.js` / `events.js`）时，profile 的
`patchReload: live` 会生效，但新装的包仍建议重启一次以加载最新模块。

### 游戏侧

`.minecraft/mods` 里需要：

- `httpdprovider` + `mcctl` + `advanced-info-fetch` + `craftcmd`，共享 HTTP 服务监听
  `127.0.0.1:3420`（游戏窗口标题会带 ` - 3420`）；
- 事件订阅另需 MC Event Reporter（`events` 模组），默认 POST 到 `127.0.0.1:3422`；
- 可选：`mgbaritoneconnector` + Baritone（`/bt`）、`killaura`（`/ka`）。

## 验证

```sh
# 离线测试（在仓库根目录）
node --test test/

# bundle 层被加载
dsh --profile web --dump-config | grep -nE "preset-mc|preset-mc-plus|mc-connect-ui|mc-tools"

# 界面状态路由（DSH Web 起在 3080）
curl -s http://127.0.0.1:3080/api/dsh-mc-connect/listener
```

在新会话里选「MC 模式」，调 `mc_status`：游戏没开时会返回一句可读的中文错误，
说明桥通了；其他模式（标准 / PTC / 极简 / 创造 / 数学）的工具表里没有 `mc_*`，
也没有 `subscribe_mc_event`。

## 排障

| 现象 | 处理 |
|---|---|
| `mc_status` 报连不上 3420 | 确认游戏在跑、`httpdprovider` 等模组已加载；`curl -s http://127.0.0.1:3420/` 应有接口索引 |
| `subscribe_mc_event` 报 `EADDRINUSE` | 停掉占用 3422 的 Python 接收端，或改 `eventPort`（两个 preset 都要改） |
| 订阅成功但收不到事件 | 确认 MC Event Reporter 在跑，且 POST 地址就是工具返回的 endpoint；`curl -X POST -H 'Content-Type: application/json' --data '{"type":"hello","data":{}}' <endpoint>` 自测 |
| 事件到了但 Agent 没反应 | 先看设置页开关是否暂停；再确认 Agent 是否正在跑很长的工具调用；`status` 的 `pending` 可确认缓冲 |
| 截图只有一行「图片不可用」 | 当前模型路由没有声明图片输入；换支持图片的模型，或继续用文本信息 |
| 工具不出现 | 确认当前会话用的是 MC / MC+ preset；`dsh --profile web --dump-config` 里应有 `mc-tools` 行 |
| 输入框下方没有控件 | 只有当前会话有订阅时才显示；没有订阅时到设置页看开关与列表 |

## 测试

`node --test test/` 使用假 Context 与真实 localhost HTTP，不依赖 DSH 或真实游戏，
覆盖：

- 14 个 `mc_*` 的注册、参数校验、请求体、错误路径、截图图片准入与降级；
- 事件订阅、过滤、合并、`steer`/`followup`、冷启动、停止、过期、`max_events`、
  端口冲突、两个 preset 实例共享监听器；
- 投递开关暂停/恢复、会话列表与清除、唯一界面路由、非回环与非法开关值；
- `working_directory` 收口与单包 manifest / client id。

## 许可证

- **代码与配置**（`*.js`、`cordis.patch.yml`、`package.json`、`locale/*.json`、
  `icon.svg`）：GPL-3.0-only，见 [LICENSE](LICENSE)。
  其中 `bridge.js` 与 `events.js` 衍生自 MineAgent 的
  [MCPServer](https://github.com/MineAgent/MCPServer) 与
  [eventsDSHPlug](https://github.com/MineAgent/eventsDSHPlug)（同为
  GPL-3.0-only），保留原作者署名。
- **文档**（`README.md` 及其他 `.md`）：CC BY-NC-SA 4.0，见
  [LICENSE.CC-BY-NC-SA-4.0](LICENSE.CC-BY-NC-SA-4.0)。
