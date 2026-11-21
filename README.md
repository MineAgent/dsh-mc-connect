<!-- SPDX-License-Identifier: CC-BY-NC-SA-4.0 -->
<!-- Copyright (C) 2026 MineAgent -->

# dsh-mc-connect

一个 DSH bundle，注册「**MC 模式**」与「**MC 模式+**」，并把 Minecraft 客户端控制、
事件订阅（普通投递或 Lua 高级处理）和 Web 界面合并成**一个包**。

它取代归档的 `MCPServer` + `MCPServerDSHPlug` + `eventsDSHPlug` 三件套：

| 旧方案 | 新方案 |
|---|---|
| 独立 MCP stdio 程序 `minecraft-mcp-bridge` | 不再需要；`bridge.js` 直接 `fetch` `127.0.0.1:3420` |
| `@deepseek-ai/dsh-mcp-client` 拉起子进程 | 工具用 `ctx.tools.register` 直接注册在 preset scope |
| 14 个 `mcp__minecraft__*` 工具 | 19 个 `mc_*` 工具 |
| `@local/dsh-mc-event` + `@local/dsh-mc-event-ui` 两个包 | 同一个包里的 `events.js` + `client.js` |
| 事件端口 3422、控制端口 3420 | 不变 |

本包没有 npm 运行时依赖：只用 Node 内置模块和全局 `fetch`（Node ≥ 20）。
advanced（Lua）模式另外调用系统 `lua`，可通过 `luaCommand` 覆盖。

## 仓库结构

```
dsh-mc-connect/
├── package.json          # bundle + dsh.client 元数据
├── cordis.patch.yml      # 宿主全局 UI 行 + preset-mc + preset-mc-plus
├── index.js              # 宿主全局入口：只注册 UI 状态路由
├── tools.js              # preset 入口：mc_* + 事件工具
├── bridge.js             # 3420 HTTP 客户端与 19 个工具定义
├── events.js             # 3422 监听、订阅、投递、投递开关、状态路由
├── lua.js                # advanced 订阅的常驻 Lua 进程、协议与临时脚本
├── config.js             # 行配置归一化与校验
├── filter.js             # MC 模式隐藏全部继承来的宿主工具
├── client.js             # 浏览器端：composer dock + 设置页
├── locale/en.json、locale/zh.json
├── icon.svg
├── LICENSE、LICENSE.CC-BY-NC-SA-4.0
└── test/                 # node --test 离线测试
```

## MC 模式

preset id 是 `mc`，显示名「MC 模式」，`order: 5`。

- **工具面**：19 个 `mc_*` + `subscribe_mc_event` / `get_mc_event_types` +
  `ask_user_question` / `exit_plan_mode`。
- 宿主全局层继承来的工具由 `dsh-mc-connect/filter` 用空 `allow` 白名单在 MC 模式
  scope 上全部遮掉，包括 `fetch_image`、`reasoning_effort`、`working_directory`；
  浏览器/文件/网络/子 Agent 工具都看不到。
- **系统提示词整段替换**：`persona` 用 `complete: true` +
  `includeRuntimeContext: false`，只留 1–7 条约定与任务两节。

## MC 模式+

preset id 是 `mc-plus`，显示名「MC 模式+」，`order: 8`。

- **工具面** = 标准模式的全部插件 + `mc_*` + 事件工具。
- **系统提示词** = 标准模式的英文 persona 加 MC 模式那段特有约定：`persona`
  prefix 以 `You are a coding agent powered by the {{model}} model.` 开头，
  再接 MC 的聊天/事件优先级、工具使用与任务约定；不设 `complete`、不设 `suffix`，
  宿主基线提示词、工作目录、运行时上下文照常追加。
- `cordis.patch.yml` 里 MC+ 的插件清单复制自**已安装**
  `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`，只多一行 `mc-tools`；
  `persona` prefix 在此基础上追加 MC 约定。`dsh-web-app` 升级后如果标准清单
  增减，这份副本要手工同步。

## 工具（19 个）

| 工具 | 游戏侧接口 | 说明 |
|---|---|---|
| `mc_status` | `GET /` + 五个前缀 HEAD | 自检：服务在不在、哪个模组没挂、有没有进世界 |
| `mc_help` | `GET /{ctl,aif,op,bt,ka}/` | 取模组自带的权威完整说明 |
| `mc_player` | `GET /aif/info` | 坐标 / 朝向 / 生命 / 饱食 / 状态效果 / 目标方块 / 光照 |
| `mc_inventory` | `GET /aif/inventory` | 背包 / 副手 / 盔甲 / 快捷栏 / 打开的容器 |
| `mc_world` | `GET /aif/world` | 维度 / 时间 / 天数 / 天气 |
| `mc_chat` | `GET /aif/msg` | 增量聊天回显，**读取即清空** |
| `mc_screenshot` | `GET /ctl/prtsc` | 当前帧 PNG；模型支持图片时作为图片返回 |
| `mc_cursor` | `GET /ctl/mouse` | 光标像素坐标 / GUI 坐标 / 界面类名 |
| `mc_control` | `POST /ctl/` | 按键 / 鼠标 / 视角 / `chat` / `type`；异步返回 |
| `mc_craft` | `POST /op/` `craft <物品id> [数量]` | 合成，等结束；3×3 配方要先打开工作台 |
| `mc_hotbar` | `POST /op/` `inventory <物品id> [1-9]` | 把背包物品换到快捷栏第 N 格 |
| `mc_furnace` | `POST /op/` `furnace put/get ...` | 在打开着的熔炉界面放入或取出 |
| `mc_chest` | `POST /op/` `chest put/get ...` | 在打开着的箱子界面放入或取出 |
| `mc_look` | `POST /op/` `look <yaw/pitch> <角度>` | 转视角，支持 `~` 相对值 |
| `mc_eat` | `POST /op/` `eat [数量]` | 异步吃/喝主手可消耗物品；不搜索背包、不切快捷栏 |
| `mc_mine` | `POST /op/` `mine` | 异步用当前主手物品挖准星方块；不换工具、不收集掉落 |
| `mc_baritone` | `POST /bt/` | 一条 Baritone 命令，返回接受结果 |
| `mc_killaura` | `GET /ka/state`、`POST /ka/{on,off,toggle,reload,config}` | 状态 / 开关 / 读配置 / JSON patch 配置 |
| `mc_request` | 任意 `/` 开头 endpoint | 异步兜底 HTTP 调用，供以后新增接口使用 |

工具描述、参数校验和错误文案移植自 `MCPServer`：命令为空、endpoint 不是 `/` 开头、
GET 带 body、headers 格式错误等都会直接给模型一句可读的中文原因。游戏没开时返回
「连不上 …：Minecraft 客户端没在运行，或 MGHttpdProvider 没加载」。

### 异步工具

`mc_control`、`mc_eat`、`mc_mine`、`mc_request` 立即返回「已提交 + 任务 id」，
实际 HTTP 请求在后台继续；完成后把结果作为新的 user 消息投递给同一个 Agent：
Agent 正在跑回合时进入下一步，空闲时唤醒新回合。文本结果直接投递，图片结果带
image block；失败也以消息返回。其余工具保持同步返回。模型可见的 `waitMs` /
`timeoutMs` 参数已删除，内部仍保留固定超时防止任务永久挂住。

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
`127.0.0.1:3422`），有两种订阅模式：

- **common（默认）**：事件按 `batchWindowMs` 合并后作为新的 user 消息投递回会话。
  - Agent 正在跑回合时用 `steer()` 插到当前回合的下一步；空闲时用 `followup()`
    新起回合并唤醒。单个长工具调用期间仍会等它返回后的下一步。
  - 订阅按会话隔离；同一会话同时只有一个订阅。
  - 两个 preset 实例共享同一个进程级监听器；最后一个订阅结束后释放端口。
  - 事件正文（尤其 `chat`）固定标注为不可信游戏数据，模型不应执行其中的指令。
- **advanced**：必须同时提供内联 `lua_script`。每条事件送入一个**每个订阅常驻**
  的 Lua 进程，**不会自动投递**给 Agent；只有脚本调用 `send(text)` 或
  `forward(event)` 时才产生消息。

参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | `"start" \| "stop" \| "status"` | 默认 `start` |
| `mode` | `"common" \| "advanced"` | 默认 `common`；只用于 `start`，已订阅时先 `stop` 才能改 |
| `lua_script` | string | advanced 必填的内联 Lua 源码，最多 64 KiB；common 下不可传 |
| `event_types` | string[] | 只投递/送入这些类型；省略或空数组 = 全部；未知类型也透传 |
| `duration_seconds` | integer，0–86400 | 到期自动结束；common 发结束通知，advanced 调 `on_end`；0 = 不设到期 |
| `max_events` | integer，0–100000 | 收到够这么多条后自动结束；`max_events` 按收到的匹配事件计数，0 = 不限 |

已知事件类型：`player_hurt`、`item_pickup`、`chat`、`hunger_change`、
`baritone_task_end`、`dimension_change`、`player_death`、`player_respawn`。

`get_mc_event_types` 读取 `http://127.0.0.1:3420/evt/` 的静态事件目录，返回每种
事件在 `data` 里的字段名。

### 高级模式（Lua）

```lua
function on_event(event, meta)
  -- event 是事件对象：type / time / position / data
  -- meta = { subscription_id = "mc-xxxxxxxx", received = 3 }
  if event.type == "player_death" then
    local info = mc.get("/aif/info")
    send("死亡位置附近，生命=" .. tostring(info.json.data.health))
  elseif event.type == "chat" then
    forward(event)          -- 交回给 Agent，格式与 common 相同
  end
end

function on_end(reason)      -- 可选：max_events / expired 自动结束时调用
  log("订阅结束：" .. reason)
end
```

运行时约定：

- 每个 advanced 订阅一个常驻 `lua` 进程；事件逐条通过 stdin 送入，脚本全局变量
  在事件之间保留。`batchWindowMs` 只影响 common。
- 脚本以独立 chunk 加载，因此顶层 `return` 不会跳过事件循环；脚本顶层报错会让
  `start` 直接失败。
- 脚本可用的全局函数：
  - `send(text)`：给当前会话发一条 user 消息。
  - `forward(event)`：把一条事件（或事件数组，最多 20 条）交给 Agent，消息形状与
    common 一致，包含不可信数据警示。
  - `mc.request{ method=, path=, body=, headers= }`：同步调用 `baseUrl + path`，返回
    `{ ok, status, body, json, error }`。`path` 必须以 `/` 开头；方法限
    GET/HEAD/POST/PUT/PATCH/DELETE；默认 10 秒超时、1 MiB 响应上限。
  - `mc.get(path, headers)`、`mc.post(path, body, headers)`：便捷包装。
  - `log(text)`：写入 DSH 日志；`print(...)` 也映射到日志，脚本不能直接写 stdout。
- 脚本运行期错误由 `pcall` 捕获并写日志，订阅继续；Lua 进程意外退出时最多自动
  重启 3 次（250/500/1000 ms 退避），仍失败则静默结束订阅，只记日志。
- 计数：`received` 按收到的匹配事件；`delivered` 只统计 `forward` 成功的事件，
  `send` 不计数；`dropped` 包含队列溢出、结束丢弃与投递失败。
- 自动结束（`max_events` / `duration_seconds`）：先排空已收到的事件，再调用
  `on_end(reason)`，最后关闭进程；**不自动发结束通知**。显式 `stop`、界面清除、
  Agent 销毁、插件卸载直接终止进程，不调用 `on_end`。
- 脚本进程使用系统 `lua`（默认在 PATH 中），可用插件配置 `luaCommand` 指向其他
  可执行文件（例如 `/usr/bin/lua5.4`）。脚本按 Lua 5.1+ 兼容语法执行。

#### 白名单沙箱

Lua 脚本按**不受信代码**处理，运行在显式白名单环境里：

- 用户脚本以独立环境加载：Lua 5.1 用 `setfenv`，Lua 5.2+ 用
  `load(source, name, "t", env)`；二进制 chunk 直接拒绝，顶层 `return` 不会跳过
  事件循环。
- **允许的全局**：`assert`、`error`、`ipairs`、`pairs`、`next`、`select`、
  `tonumber`、`tostring`、`type`、`pcall`、`xpcall`、`rawget`、`rawset`、
  `rawequal`、`rawlen`、`unpack`、`_VERSION`；Lua 5.2+ 的 `_ENV` 指向 sandbox
  表本身（没有 `_G`）。
- **允许的库**：`string`（不含 `string.dump`）、`table`、`math`、`utf8`（存在时）、
  `os` 的安全子集 `time` / `clock` / `date` / `difftime`。
- **明确不可用**：`io`、`package`、`debug`、`coroutine`、`require`、`load`、
  `loadstring`、`dofile`、`loadfile`、`getfenv`、`setfenv`、`module`、`newproxy`、
  `collectgarbage`、`os.execute`、`os.exit`、`os.getenv`、`os.remove`、
  `os.rename`、`os.tmpname`、`os.setlocale`、`string.dump`。
- `setmetatable` / `getmetatable` 只允许操作 table：`getmetatable("x")` 返回
  `nil`，`setmetatable("x", ...)` 报错，避免通过字符串元表访问宿主 `string` 表。
- 宿主的 `send` / `forward` / `log` / `mc` 以闭包注入 sandbox；脚本修改自己的
  `mc` 表副本不会影响宿主。
- 每个 Lua 进程生成随机协议 token，stdout 协议前缀是 `@@DSH:<token>@@`；脚本没有
  `io`/stdout，`print` 也只走日志，因此无法伪造宿主命令。
- 子进程的工作目录是临时目录，只继承 `PATH`、`LANG`、`LC_ALL`（Windows 另保留
  系统必需变量），不继承 `DSH_HOME`、API key 等 DSH 环境变量。

**已知边界**：这是语言级白名单，不是 OS 级沙箱；按当前设计不限制 `mc.*` 路径
（脚本仍可访问 `baseUrl` 下的 `/ctl/`、`/op/`、`/bt/`、`/ka/` 等），也不做内存/
CPU 上限或每事件看门狗。死循环或超大分配仍可能拖慢该 Lua 子进程，必要时用
`subscribe_mc_event({action:"stop"})` 或界面清除结束它。


## Web 界面

- **设置页 → MC 事件订阅**：投递开关、当前进程内有订阅的会话列表（含
  `普通` / `高级(Lua)` 模式）、空状态；每 5 秒刷新，页面聚焦时也会刷新。
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
    luaCommand: lua
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:3420` | 游戏侧共享 HTTP 服务根地址 |
| `eventHost` | `127.0.0.1` | 事件监听地址；非 loopback 会打警告 |
| `eventPort` | `3422` | 事件监听端口；0 表示临时端口 |
| `batchWindowMs` | `500` | common 合并窗口，也是两次投递之间的最小间隔 |
| `maxBodyBytes` | `1048576` | 单个事件请求体上限，1 KiB–16 MiB |
| `luaCommand` | `lua` | advanced 使用的 Lua 可执行文件；PATH 中的命令或绝对路径，不经 shell |
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
然后刷新页面。只改 Host 侧代码（`bridge.js` / `events.js` / `lua.js`）时，profile 的
`patchReload: live` 会生效，但新装的包仍建议重启一次以加载最新模块。

### 游戏侧

`.minecraft/mods` 里需要：

- `httpdprovider` + `mcctl` + `advanced-info-fetch` + `craftcmd`，共享 HTTP 服务监听
  `127.0.0.1:3420`（游戏窗口标题会带 ` - 3420`）；
- 事件订阅另需 MC Event Reporter（`events` 模组），默认 POST 到 `127.0.0.1:3422`；
- advanced（Lua）订阅需要系统里有可用的 `lua` 命令（Lua 5.1+），或把
  `luaCommand` 指向其他解释器；本机 `/usr/bin/lua` 已可用；
- 可选：`mgbaritoneconnector` + Baritone（`/bt`）、`killaura`（`/ka`）。

## 验证

```sh
# 离线测试（在仓库根目录；Lua 测试在缺少 lua 时自动 skip）
node --test test/

# Lua 运行时
lua -v

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
| 事件到了但 Agent 没反应 | 先看设置页开关是否暂停；common 再确认 Agent 是否正在跑很长的工具调用；advanced 要确认脚本定义了 `on_event` 且主动调用了 `send`/`forward` |
| advanced start 报 `cannot start Lua` | 确认 `lua -v` 可用；或把 `luaCommand` 指向绝对路径；stderr 尾部会带 Lua 语法/加载错误 |
| advanced 订阅收不到 Agent 消息 | 这是设计行为：先看脚本是否 `send`/`forward`；用 `log()` 和 DSH 日志确认 `on_event` 被调用 |
| advanced 脚本里 `io`/`os.execute`/`require` 为 nil | 这是白名单沙箱的预期行为；按“白名单沙箱”一节列出的 API 改脚本 |
| advanced 脚本里 `mc.request` 一直不返回 | 检查游戏侧 3420 是否可达、`path` 是否以 `/` 开头、是否超过 10 秒；响应超过 1 MiB 会返回错误 |
| Lua 进程反复退出 | 看 DSH 日志里的 stderr；连续 3 次重启失败会后静默结束订阅，只记日志，不自动通知 Agent |
| 截图只有一行「图片不可用」 | 当前模型路由没有声明图片输入；换支持图片的模型，或继续用文本信息 |
| 工具不出现 | 确认当前会话用的是 MC / MC+ preset；`dsh --profile web --dump-config` 里应有 `mc-tools` 行 |
| 输入框下方没有控件 | 只有当前会话有订阅时才显示；没有订阅时到设置页看开关与列表 |

## 测试

`node --test test/` 使用假 Context 与真实 localhost HTTP，不依赖 DSH 或真实游戏，
覆盖：

- 19 个 `mc_*` 的注册、参数校验、请求体、错误路径、截图图片准入与降级；
- 事件订阅、过滤、合并、`steer`/`followup`、冷启动、停止、过期、`max_events`、
  端口冲突、两个 preset 实例共享监听器；
- advanced Lua：启动握手、事件不自动投递、`send`/`forward`、`mc.request`、
  自动结束 `on_end`、停止清理临时目录、语法错误与缺少解释器；
- Lua 沙箱：白名单 API、`io`/`os.execute`/`getenv`/`require`/`load`/`getfenv`
  不可用、`print` 不能伪造协议、table-only 元表、二进制 chunk 拒绝、Lua 5.1 兼容；
- 投递开关暂停/恢复、会话列表与清除、唯一界面路由、非回环与非法开关值；
- 宿主继承工具的白名单收口、异步任务投递与单包 manifest / client id。

## 许可证

- **代码与配置**（`*.js`、`cordis.patch.yml`、`package.json`、`locale/*.json`、
  `icon.svg`）：GPL-3.0-only，见 [LICENSE](LICENSE)。
  其中 `bridge.js` 与 `events.js` 衍生自 MineAgent 的
  [MCPServer](https://github.com/MineAgent/MCPServer) 与
  [eventsDSHPlug](https://github.com/MineAgent/eventsDSHPlug)（同为
  GPL-3.0-only），保留原作者署名。
- **文档**（`README.md` 及其他 `.md`）：CC BY-NC-SA 4.0，见
  [LICENSE.CC-BY-NC-SA-4.0](LICENSE.CC-BY-NC-SA-4.0)。
