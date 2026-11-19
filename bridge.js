// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MineAgent
//
// 移植自 MineAgent/MCPServer 的 mcp stdio 桥（GPL-3.0-only）。
/**
 * Minecraft 客户端直连桥：把 `.minecraft/mods/` 里几个客户端模组挂在
 * `http://127.0.0.1:3420` 的共享 HTTP 接口映射成 DSH 原生工具。
 *
 *   /ctl  mcctl               控制：按键 / 鼠标 / 视角 / 截图 / 聊天 / 打字
 *   /aif  AdvancedInfoFetcher 只读状态：坐标 / 目标方块 / 背包 / 聊天 / 世界
 *   /op   Craft Command       容器操作：合成 / 熔炉 / 箱子 / 快捷栏 / 转向
 *   /bt   MGBaritoneConnector Baritone 命令
 *   /ka   Kill Aura          Kill Aura 开关与配置
 *
 * 与归档 MCP 版的区别：这里没有 MCP 协议、没有子进程，工具直接注册在
 * 挂载它的 preset scope 上；请求用全局 fetch，截图/图片走 DSH 的
 * attachment store（模型不支持图片时降级为文本诊断）。
 *
 * @module dsh-mc-connect/bridge
 */

/** 各类请求的超时：/op 的合成与含 type 的 /ctl 请求都会同步阻塞到执行结束。 */
const TIMEOUT = {
  read: 15_000,
  status: 5_000,
  screenshot: 20_000,
  control: 150_000,
  op: 180_000,
  baritone: 15_000,
  killaura: 15_000,
  request: 30_000,
};

/** 通用兜底请求允许的最大超时与响应体大小。 */
const REQUEST_MAX_TIMEOUT = 180_000;
const REQUEST_MAX_BYTES = 8 * 1024 * 1024;

/** 工具调用预算：比内部超时多留一点，让内部超时先给出中文说明。 */
const TOOL_TIMEOUT = {
  read: 20_000,
  status: 15_000,
  screenshot: 25_000,
  control: 160_000,
  op: 190_000,
  baritone: 20_000,
  killaura: 20_000,
  request: 185_000,
};

/** HTTP 状态码的中文含义（模组自己的错误正文会附在后面）。 */
const STATUS_HINT = {
  400: '请求被拒',
  401: '未授权',
  403: '禁止访问',
  404: '路径不存在',
  405: '方法不允许',
  409: '客户端没在世界里',
  413: '请求体过大',
  429: '请求太频繁',
  500: '模组内部错误',
  503: '无法排队',
  504: '等客户端超时',
};

/** 共享 HTTP 服务上已知的前缀；status 与 help 用它保持顺序一致。 */
const PREFIXES = [
  { key: 'ctl', label: '/ctl 控制' },
  { key: 'aif', label: '/aif 只读状态' },
  { key: 'op', label: '/op 容器操作' },
  { key: 'bt', label: '/bt Baritone' },
  { key: 'ka', label: '/ka Kill Aura' },
];

/** 可用的请求方法。 */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** 文本工具的统一 canonical value。 */
const TEXT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
  },
  required: ['text'],
  additionalProperties: false,
};

/** 可能带图片的工具的 canonical value。 */
const IMAGE_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    image: {
      type: 'object',
      properties: {
        attachmentId: { type: 'string' },
        mediaType: { type: 'string' },
        bytes: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
      required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
      additionalProperties: false,
    },
  },
  required: ['text'],
  additionalProperties: false,
};

/** 空参数对象。 */
const NO_PARAMETERS = { type: 'object', properties: {}, additionalProperties: false };

/** 桥接层自身的失败（连不上、超时、非 200）；正文直接给模型看。 */
class BridgeError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 把非 2xx 响应整理成一句给模型看的错误。
 * @param {number} status - HTTP 状态码。
 * @param {string} detail - 响应正文。
 * @returns {BridgeError} 错误。
 */
function httpError(status, detail) {
  const hint = STATUS_HINT[status] ?? '';
  return new BridgeError(`HTTP ${status}${hint ? ` ${hint}` : ''}${detail ? `：${detail}` : ''}`);
}

/**
 * 造一个绑定到某个服务地址的请求函数。
 *
 * 返回的函数带一个 `raw` 属性：它只做传输，不把非 2xx 当异常，供通用
 * `mc_request` 工具读取状态码与响应体。
 *
 * @param {string} baseUrl 形如 `http://127.0.0.1:3420` 的根地址
 * @returns {((path: string, options?: object) => Promise<string|Buffer>) & { raw: (path: string, options?: object) => Promise<Response> }}
 */
function makeRequest(baseUrl) {
  /**
   * 只负责发请求；网络错误与超时统一转成 BridgeError。
   * @param {string} path - 以 / 开头的相对路径。
   * @param {object} [options] - 方法、body、headers、超时与取消信号。
   * @returns {Promise<Response>} 原始响应。
   */
  async function fetchResponse(path, options = {}) {
    const { method = 'GET', body, headers, timeoutMs = TIMEOUT.read, signal } = options;
    const url = baseUrl + path;
    const requestHeaders = {
      ...(body === undefined ? {} : { 'content-type': 'text/plain; charset=utf-8' }),
      ...headers,
    };
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal !== undefined) signals.push(signal);

    try {
      return await fetch(url, {
        method,
        ...(body === undefined ? {} : { body }),
        ...(Object.keys(requestHeaders).length === 0 ? {} : { headers: requestHeaders }),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (error?.name === 'TimeoutError') {
        throw new BridgeError(
          `等待 ${url} 超过 ${timeoutMs}ms 没有响应：命令可能还在游戏里继续跑，稍后用 mc_player / mc_chat 对账。`,
        );
      }
      const cause = error?.cause?.code ?? error?.message ?? error;
      throw new BridgeError(
        `连不上 ${url}：Minecraft 客户端没在运行，或 MGHttpdProvider 没加载。（${cause}）`,
      );
    }
  }

  /**
   * 发请求并把非 2xx 转成 BridgeError；`binary` 时返回 Buffer。
   * @param {string} path - 相对路径。
   * @param {object} [options] - 请求选项。
   * @returns {Promise<string|Buffer>} 响应正文。
   */
  const request = async function request(path, options = {}) {
    const response = await fetchResponse(path, options);
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim();
      throw httpError(response.status, detail);
    }
    if (options.binary === true) return Buffer.from(await response.arrayBuffer());
    return await response.text();
  };

  request.raw = (path, options) => fetchResponse(path, options);
  return request;
}

/** 尽量把 JSON 响应排版，解析不了就原样返回。 */
function prettyJson(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

/**
 * 解析通用请求的 `Name: value` 头；格式不对时给模型一句可读的错误。
 * @param {unknown} lines - 模型给出的头数组。
 * @returns {Record<string, string>} 请求头。
 */
function parseHeaderLines(lines) {
  if (lines === undefined) return {};
  if (!Array.isArray(lines)) throw new BridgeError('headers 必须是字符串数组，每项写成 "Name: value"。');
  const headers = {};
  for (const line of lines) {
    if (typeof line !== 'string') throw new BridgeError('headers 的每一项都必须是字符串。');
    const index = line.indexOf(':');
    if (index <= 0) throw new BridgeError(`headers 里的 ${JSON.stringify(line)} 不是 "Name: value" 形式。`);
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (name.length === 0) throw new BridgeError(`headers 里的 ${JSON.stringify(line)} 缺少头名称。`);
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      throw new BridgeError(`headers 里的头名称 ${JSON.stringify(name)} 含有非法字符。`);
    }
    headers[name] = value;
  }
  return headers;
}

/** 从 PNG 的 IHDR 里读画面尺寸，用来在截图结果里说清坐标系。 */
function pngSize(buffer) {
  if (buffer.length >= 24 && buffer.toString('latin1', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  return undefined;
}

/**
 * 要求一个非空字符串；返回去空白后的值。
 * @param {unknown} value - 参数值。
 * @param {string} field - 参数名。
 * @returns {string} 非空文本。
 */
function requireCommand(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BridgeError(`${field} 不能为空。`);
  }
  return value.trim();
}

/**
 * 要求一个非空、不含空白的字符串；用于命令里的单个 token。
 * @param {unknown} value - 参数值。
 * @param {string} field - 参数名。
 * @returns {string} 去空白后的单个 token。
 */
function requireToken(value, field) {
  const text = requireCommand(value, field);
  if (/\s/.test(text)) {
    throw new BridgeError(`${field} 不能包含空白。`);
  }
  return text;
}

/**
 * 校验枚举参数。
 * @param {unknown} value - 参数值。
 * @param {readonly string[]} allowed - 允许值。
 * @param {string} field - 参数名。
 * @param {string} [fallback] - 缺失时的默认值。
 * @returns {string} 合法值。
 */
function enumValue(value, allowed, field, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new BridgeError(`${field} 必须是 ${allowed.join('/')} 之一。`);
  }
  return value;
}

/**
 * 归一化 waitMs：缺失为 0，夹到 0–60000。
 * @param {unknown} value - 参数值。
 * @returns {number} 毫秒。
 */
function waitMsValue(value) {
  if (value === undefined) return 0;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new BridgeError('waitMs 必须是数字。');
  return Math.min(Math.max(Math.trunc(number), 0), 60_000);
}

/**
 * 归一化有界整数参数：缺失时用 fallback，否则必须是范围内的整数。
 * @param {unknown} value - 参数值。
 * @param {number} min - 最小值。
 * @param {number} max - 最大值。
 * @param {string} field - 参数名。
 * @param {number} fallback - 缺失时的默认值。
 * @returns {number} 合法整数。
 */
function integerValue(value, min, max, field, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new BridgeError(`${field} 必须是 ${min}–${max} 的整数。`);
  }
  return number;
}

/**
 * 归一化通用请求的超时：默认 30000，夹到 1000–180000。
 * @param {unknown} value - 参数值。
 * @returns {number} 毫秒。
 */
function requestTimeout(value) {
  if (value === undefined) return TIMEOUT.request;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new BridgeError('timeoutMs 必须是数字。');
  return Math.min(Math.max(Math.trunc(number), 1_000), REQUEST_MAX_TIMEOUT);
}

/**
 * 把图片保存进 DSH 的附件存储；失败时返回给模型看的诊断文本。
 *
 * 与 dsh-mcp-client 的准入一致：需要 attachment store，并且当前模型路由
 * 明确声明图片输入。准入失败不让工具调用失败，只把图片换成一行诊断。
 *
 * @param {object} ctx - preset scope 上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {Buffer} bytes - PNG/JPEG/WebP/GIF 编码字节。
 * @param {string} mediaType - 声明的媒体类型。
 * @returns {Promise<{ ref?: object, diagnostic?: string }>} 准入结果。
 */
async function admitImage(ctx, exec, bytes, mediaType) {
  try {
    const attachments = ctx.get('attachments');
    if (attachments === undefined) throw new Error('没有挂载附件存储');
    const routed = exec.agent?.session?.requestHeader?.()?.config;
    const provider = routed?.provider ?? exec.agent?.options?.provider;
    const model = routed?.model ?? exec.agent?.options?.model;
    const llm = ctx.get('llm');
    if (provider === undefined || model === undefined || llm === undefined) {
      throw new Error('无法解析当前模型路由');
    }
    const info = await llm.resolveModelInfo(provider, model, exec.signal);
    if (info?.inputModalities === undefined || !info.inputModalities.includes('image')) {
      throw new Error(`模型 "${model}" 未声明图片输入`);
    }
    if (exec.signal.aborted) throw new Error('调用已取消，图片未保存');
    const saved = await attachments.saveImage({ data: bytes, mediaType });
    return {
      ref: {
        attachmentId: saved.attachmentId,
        mediaType: saved.mediaType,
        bytes: saved.bytes,
        width: saved.width,
        height: saved.height,
      },
    };
  } catch (error) {
    return {
      diagnostic: `[图片不可用：${mediaType}；${error?.message ?? error}；图片原始数据仍可供程序调用方读取]`,
    };
  }
}

/**
 * 造一个纯文本工具定义。
 * @param {object} spec - 名称、描述、参数、超时与执行函数。
 * @returns {object} 可直接交给 ctx.tools.register 的定义。
 */
function textDefinition(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters ?? NO_PARAMETERS,
    timeoutMs: spec.timeoutMs,
    output: {
      schema: TEXT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: value.text.length > 0 ? value.text : '(空)' }];
      },
    },
    async execute(args, exec) {
      return { text: await spec.run(args ?? {}, exec) };
    },
  };
}

/**
 * 造一个可能返回图片的工具定义。
 * @param {object} spec - 名称、描述、参数、超时与执行函数。
 * @returns {object} 可直接交给 ctx.tools.register 的定义。
 */
function imageDefinition(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters ?? NO_PARAMETERS,
    timeoutMs: spec.timeoutMs,
    output: {
      schema: IMAGE_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: value.text.length > 0 ? value.text : '(空)' }];
      },
    },
    projectContent(_exec, result) {
      if (result.isError === true) return undefined;
      const value = result.value;
      if (value === undefined || value.image === undefined) return undefined;
      return [
        { type: 'image', attachment: value.image },
        { type: 'text', text: value.text },
      ];
    },
    async execute(args, exec) {
      return spec.run(args ?? {}, exec);
    },
  };
}

/**
 * 注册 19 个 Minecraft 控制/观测工具。
 *
 * @param {object} ctx - preset scope 上下文（提供 tools，可选 attachments/llm）。
 * @param {{ baseUrl: string }} config - 已归一化配置。
 * @returns {() => void} 注销全部工具的清理函数。
 */
export function registerBridgeTools(ctx, config) {
  const baseUrl = config.baseUrl;
  const request = makeRequest(baseUrl);

  /**
   * 一次快照式读取（/aif/*）。
   * @param {string} path - 接口路径。
   * @param {string} emptyText - 空响应时的占位文案。
   * @param {string} [timeout] - 超时键。
   * @returns {(args: object, exec: object) => Promise<string>} 执行函数。
   */
  const snapshot = (path, emptyText, timeout = 'read') =>
    async (_args, exec) => {
      const text = (await request(path, { timeoutMs: TIMEOUT[timeout], signal: exec.signal })).trim();
      return text.length > 0 ? text : emptyText;
    };

  const definitions = [
    textDefinition({
      name: 'mc_status',
      description:
        '检查控制服务是否在跑、/ctl（控制）、/aif（只读状态）、/op（容器操作）、/bt（Baritone）、/ka（Kill Aura）五个接口各是否挂载、客户端是否已进入世界，并给出接口索引。刚启动游戏或任何调用异常时先跑它。',
      timeoutMs: TOOL_TIMEOUT.status,
      async run(_args, exec) {
        const index = await request('/', { timeoutMs: TIMEOUT.status, signal: exec.signal });
        const mounted = {};
        for (const { key } of PREFIXES) {
          try {
            await request(`/${key}/`, {
              method: 'HEAD',
              timeoutMs: TIMEOUT.status,
              signal: exec.signal,
            });
            mounted[key] = true;
          } catch {
            mounted[key] = false;
          }
        }

        let world = '未知（/aif 不可用）';
        if (mounted.aif) {
          try {
            await request('/aif/info', { timeoutMs: TIMEOUT.status, signal: exec.signal });
            world = '已进入世界';
          } catch (error) {
            world = error.message.includes('HTTP 409')
              ? '未进入世界（在主菜单或加载中）'
              : `未知（${error.message}）`;
          }
        }

        return [
          `服务：${baseUrl} 可连接`,
          `世界：${world}`,
          ...PREFIXES.map(({ key, label }) => `${label}：${mounted[key] ? '可用' : '不可用'}`),
          '',
          '接口索引：',
          index.trim(),
        ].join('\n');
      },
    }),

    textDefinition({
      name: 'mc_help',
      description:
        '返回某个接口的权威完整说明（游戏内模组自带的帮助文本）。语法、按键名、返回码与限制都以它为准。新接口先用它看用法。',
      timeoutMs: TOOL_TIMEOUT.read,
      parameters: {
        type: 'object',
        properties: {
          prefix: {
            type: 'string',
            enum: ['ctl', 'aif', 'op', 'bt', 'ka'],
            description: 'ctl=控制命令；aif=只读状态；op=容器操作；bt=Baritone 命令；ka=Kill Aura',
          },
        },
        required: ['prefix'],
        additionalProperties: false,
      },
      async run(args, exec) {
        const prefix = enumValue(args.prefix, ['ctl', 'aif', 'op', 'bt', 'ka'], 'prefix');
        return (await request(`/${prefix}/`, { timeoutMs: TIMEOUT.read, signal: exec.signal })).trim();
      },
    }),

    textDefinition({
      name: 'mc_player',
      description:
        '坐标、朝向（yaw/pitch）、生命、饱食、经验、状态效果，以及准星指向的目标方块和它的光照。放置/挖掘/右键前先看目标方块；`未选中` 表示准星不在方块上。',
      timeoutMs: TOOL_TIMEOUT.read,
      run: snapshot('/aif/info', '(没有读到玩家状态)'),
    }),

    textDefinition({
      name: 'mc_inventory',
      description: '背包、副手、盔甲、快捷栏，以及当前打开的熔炉/箱子里有什么。',
      timeoutMs: TOOL_TIMEOUT.read,
      run: snapshot('/aif/inventory', '(背包是空的)'),
    }),

    textDefinition({
      name: 'mc_world',
      description: '当前维度、游戏时间与天数、天气。',
      timeoutMs: TOOL_TIMEOUT.read,
      run: snapshot('/aif/world', '(没有读到世界状态)'),
    }),

    textDefinition({
      name: 'mc_chat',
      description:
        '自上次读取以来聊天栏出现的一切。读取即清空，只返回新内容。',
      timeoutMs: TOOL_TIMEOUT.read,
      run: snapshot('/aif/msg', '（没有新的聊天内容）'),
    }),

    imageDefinition({
      name: 'mc_screenshot',
      description: '截取当前游戏帧并作为图片返回。',
      timeoutMs: TOOL_TIMEOUT.screenshot,
      async run(_args, exec) {
        const png = await request('/ctl/prtsc', {
          timeoutMs: TIMEOUT.screenshot,
          binary: true,
          signal: exec.signal,
        });
        const size = pngSize(png);
        const text = `当前帧已截取${size ? `：${size.width}×${size.height}` : ''}（PNG，窗口像素坐标系，mc_cursor 与 mouse goto 用的是同一套坐标）`;
        const admitted = await admitImage(ctx, exec, png, 'image/png');
        if (admitted.ref === undefined) return { text: `${text}\n${admitted.diagnostic}` };
        return { text, image: admitted.ref };
      },
    }),

    textDefinition({
      name: 'mc_cursor',
      description:
        '鼠标光标现在的位置：窗口像素坐标、GUI 缩放坐标、是否被窗口抓取、当前界面类名。配合 mc_control 的 `mouse goto` 做绝对定位点击。',
      timeoutMs: TOOL_TIMEOUT.read,
      run: snapshot('/ctl/mouse', '(没有读到光标位置)'),
    }),

    textDefinition({
      name: 'mc_control',
      description:
        '把一段输入序列交给游戏。多行或用 `;` 分隔，严格按顺序执行。按键/鼠标这类定时动作是排队的，命令一被接受就返回，用 waitMs 等它做完。含 `type`/`typeEnter` 需要当前有聚焦的文本框，否则整个请求失败、什么都不执行。',
      timeoutMs: TOOL_TIMEOUT.control,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'mcctl 命令文本，不能为空。常用：`W 500` 按住 W 500ms（默认 50）；`W+Ctrl 100` 同时按住多键；`mouse left|right|mid [ms]`；`mouse move <dx> <dy>` 相对移动（+右 +下）；`mouse goto <x> <y>` 移到窗口像素坐标；`mouse scroll <n>`；`delay <ms> <命令>`；`release` 立刻松开全部；`chat <文本>` 发聊天（`/` 开头当指令）；`type <文本>` 打进聚焦文本框（`\\n` 表示回车）；`typeEnter` 在文本框里回车。按键名不分大小写：A–Z、0–9、F1–F12、SPACE/TAB/ENTER/BACKSPACE/ESC/UP/DOWN/LEFT/RIGHT 等；单次时长与 delay 上限 600000ms。完整语法用 mc_help。',
          },
          waitMs: {
            type: 'integer',
            description:
              '命令被接受后等待这么久（毫秒，整数，0–60000，默认 0）再返回，用来等一次定时输入做完，省掉一次单独的状态读取',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
      async run(args, exec) {
        const command = requireCommand(args.command, 'command');
        const wait = waitMsValue(args.waitMs);
        const body = await request('/ctl/', {
          method: 'POST',
          body: command,
          timeoutMs: TIMEOUT.control,
          signal: exec.signal,
        });
        let summary = body.trim();
        try {
          const parsed = JSON.parse(body);
          const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
          summary = `已接受 ${actions.length} 个动作：${actions.join(' → ') || '(无)'}\n队列中：${parsed.queued} 个请求，在世界里：${parsed.inWorld}`;
        } catch {
          // 正文不是 JSON（理论上不会）时原样返回
        }
        if (wait > 0) {
          await sleep(wait);
          summary += `\n已等待 ${wait}ms。`;
        }
        return summary;
      },
    }),

    textDefinition({
      name: 'mc_craft',
      description:
        '用背包里的材料合成物品，等合成结束再返回。3×3 配方需要先打开工作台界面；成品放不下、原料不足、配方未解锁或合成格不空都会直接报错。',
      timeoutMs: TOOL_TIMEOUT.op,
      parameters: {
        type: 'object',
        properties: {
          item: {
            type: 'string',
            description: '要合成的物品 ID，命名空间可省略（如 crafting_table 或 minecraft:crafting_table）。',
          },
          amount: {
            type: 'integer',
            minimum: 1,
            maximum: 2304,
            description: '要合成的成品数量，默认 1，按整次合成向上取整。',
          },
        },
        required: ['item'],
        additionalProperties: false,
      },
      async run(args, exec) {
        const item = requireToken(args.item, 'item');
        const amount = integerValue(args.amount, 1, 2304, 'amount', 1);
        return (
          await request('/op/', {
            method: 'POST',
            body: `craft ${item} ${amount}`,
            timeoutMs: TIMEOUT.op,
            signal: exec.signal,
          })
        ).trim();
      },
    }),

    textDefinition({
      name: 'mc_hotbar',
      description:
        '把背包里的物品换到快捷栏第 N 格，一次点击完成。只匹配物品 ID 相同的第一堆；被换出的物品回到原格子。',
      timeoutMs: TOOL_TIMEOUT.op,
      parameters: {
        type: 'object',
        properties: {
          item: {
            type: 'string',
            description: '要换到快捷栏的物品 ID，命名空间可省略。',
          },
          slot: {
            type: 'integer',
            minimum: 1,
            maximum: 9,
            description: '目标快捷栏格，1–9，默认 1。',
          },
        },
        required: ['item'],
        additionalProperties: false,
      },
      async run(args, exec) {
        const item = requireToken(args.item, 'item');
        const slot = integerValue(args.slot, 1, 9, 'slot', 1);
        return (
          await request('/op/', {
            method: 'POST',
            body: `inventory ${item} ${slot}`,
            timeoutMs: TIMEOUT.op,
            signal: exec.signal,
          })
        ).trim();
      },
    }),

    textDefinition({
      name: 'mc_furnace',
      description:
        '在打开着的熔炉/高炉/烟熏炉界面里放入或取出物品，等操作完成再返回。必须先右键打开对应界面；put 只能写 raw 或 fuel，get 可读 raw/fuel/product，产物格不能拆分时会整堆取出。',
      timeoutMs: TOOL_TIMEOUT.op,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['put', 'get'],
            description: 'put=放入；get=取出。',
          },
          slot: {
            type: 'string',
            enum: ['raw', 'fuel', 'product'],
            description: 'raw=原料格；fuel=燃料格；product=产物格（仅 get）。',
          },
          item: {
            type: 'string',
            description: 'action=put 时必填；要放入的物品 ID，命名空间可省略。action=get 时不要提供。',
          },
          amount: {
            type: 'integer',
            minimum: 1,
            maximum: 6400,
            description: '数量，默认 1。',
          },
        },
        required: ['action', 'slot'],
        additionalProperties: false,
      },
      async run(args, exec) {
        const action = enumValue(args.action, ['put', 'get'], 'action');
        const slot = enumValue(args.slot, ['raw', 'fuel', 'product'], 'slot');
        const amount = integerValue(args.amount, 1, 6400, 'amount', 1);
        let body;
        if (action === 'put') {
          if (slot === 'product') {
            throw new BridgeError('action=put 时 slot 只能是 raw/fuel。');
          }
          const item = requireToken(args.item, 'item');
          body = `furnace put ${slot} ${item} ${amount}`;
        } else {
          if (args.item !== undefined) {
            throw new BridgeError('action=get 不接受 item。');
          }
          body = `furnace get ${slot} ${amount}`;
        }
        return (
          await request('/op/', {
            method: 'POST',
            body,
            timeoutMs: TIMEOUT.op,
            signal: exec.signal,
          })
        ).trim();
      },
    }),

    textDefinition({
      name: 'mc_chest',
      description:
        '在打开着的箱子/陷阱箱/大箱子/木桶界面里放入或取出物品，等操作完成再返回。必须先右键打开对应界面；只匹配物品 ID 和组件都相同的堆，失败时不会移动任何物品。',
      timeoutMs: TOOL_TIMEOUT.op,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['put', 'get'],
            description: 'put=放入箱子；get=从箱子取出。',
          },
          item: {
            type: 'string',
            description: '要放入或取出的物品 ID，命名空间可省略。',
          },
          amount: {
            type: 'integer',
            minimum: 1,
            maximum: 6400,
            description: '数量，默认 1。',
          },
        },
        required: ['action', 'item'],
        additionalProperties: false,
      },
      async run(args, exec) {
        const action = enumValue(args.action, ['put', 'get'], 'action');
        const item = requireToken(args.item, 'item');
        const amount = integerValue(args.amount, 1, 6400, 'amount', 1);
        return (
          await request('/op/', {
            method: 'POST',
            body: `chest ${action} ${item} ${amount}`,
            timeoutMs: TIMEOUT.op,
            signal: exec.signal,
          })
        ).trim();
      },
    }),

    textDefinition({
      name: 'mc_look',
      description:
        '转动视角。yaw 可超出 ±180，pitch 限制在 -90..90；angle 支持 `~` 相对值：90 是绝对值，~0.1 是加 0.1°，~-20 是减 20°，~ 保持不变。',
      timeoutMs: TOOL_TIMEOUT.op,
      parameters: {
        type: 'object',
        properties: {
          axis: {
            type: 'string',
            enum: ['yaw', 'pitch'],
            description: 'yaw=水平转向；pitch=俯仰。',
          },
          angle: {
            type: 'string',
            description: '角度，支持 `~` 相对写法：90、~0.1、~-20、~。',
          },
        },
        required: ['axis', 'angle'],
        additionalProperties: false,
      },
      async run(args, exec) {
        const axis = enumValue(args.axis, ['yaw', 'pitch'], 'axis');
        const angle = requireToken(args.angle, 'angle');
        return (
          await request('/op/', {
            method: 'POST',
            body: `look ${axis} ${angle}`,
            timeoutMs: TIMEOUT.op,
            signal: exec.signal,
          })
        ).trim();
      },
    }),

    textDefinition({
      name: 'mc_eat',
      description:
        '吃掉或喝掉主手上的可消耗物品（食物、药水、牛奶桶、蜂蜜瓶、蜘蛛眼等），等消耗完成再返回。只使用主手这一格，不搜索背包、不自动切快捷栏；amount 超过主手堆叠数会直接报错。生存模式饱食度已满会报错；创造模式堆叠不减少，但仍按 amount 次数完成。',
      timeoutMs: TOOL_TIMEOUT.op,
      parameters: {
        type: 'object',
        properties: {
          amount: {
            type: 'integer',
            minimum: 1,
            maximum: 2304,
            description: '要消耗的数量，默认 1；不能超过主手这一格的堆叠数。',
          },
        },
        additionalProperties: false,
      },
      async run(args, exec) {
        const amount = integerValue(args.amount, 1, 2304, 'amount', 1);
        return (
          await request('/op/', {
            method: 'POST',
            body: `eat ${amount}`,
            timeoutMs: TIMEOUT.op,
            signal: exec.signal,
          })
        ).trim();
      },
    }),

    textDefinition({
      name: 'mc_mine',
      description:
        '用当前主手物品挖掉准星瞄准的方块，等方块真正消失再返回。不会自动换工具、换快捷栏或收集掉落；没瞄准方块、基岩/屏障等不可破坏方块、权限或世界边界限制、挖掘中目标变化或走出交互距离都会直接报错。',
      timeoutMs: TOOL_TIMEOUT.op,
      async run(_args, exec) {
        return (
          await request('/op/', {
            method: 'POST',
            body: 'mine',
            timeoutMs: TIMEOUT.op,
            signal: exec.signal,
          })
        ).trim();
      },
    }),

    textDefinition({
      name: 'mc_baritone',
      description:
        '执行一条 Baritone 命令（寻路 / 自动采集 / 停止）。等价于聊天框里的 `#<命令>`，但不发聊天包；一次只能一条。命令输出仍在聊天栏，用 mc_chat 读取。',
      timeoutMs: TOOL_TIMEOUT.baritone,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              '一条 Baritone 命令，不能为空。常用：`goal <x> <y> <z>` 或 `goal ~ ~ ~20`；`goto <x> <y> <z>`；`mine <方块id>`；`stop`；`proc`。完整语法用 mc_help({prefix:"bt"})。',
          },
          waitMs: {
            type: 'integer',
            description:
              '命令被接受后等待这么久（毫秒，整数，0–60000，默认 0）再返回；Baritone 的进度仍要用 mc_chat / mc_player 对账',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
      async run(args, exec) {
        const command = requireCommand(args.command, 'command');
        const wait = waitMsValue(args.waitMs);
        const body = await request('/bt/', {
          method: 'POST',
          body: command,
          timeoutMs: TIMEOUT.baritone,
          signal: exec.signal,
        });
        let summary = body.trim();
        if (wait > 0) {
          await sleep(wait);
          summary += `\n已等待 ${wait}ms。`;
        }
        return summary;
      },
    }),

    textDefinition({
      name: 'mc_killaura',
      description:
        '读取或修改 Kill Aura：`state` 看当前状态与目标；`on` / `off` / `toggle` 开关（幂等）；`reload` 重新读取 config/killaura.json；`config` 按给出的字段部分更新配置。目标按敌意 / 中立 / 友善有掉落 / 友善无掉落分类，可用 denyTargets 拒绝、alwaysTargetsHigh/Medium/Low/Lowest 四档强制。所有写操作都返回完整状态 JSON。开关状态不持久化，重启游戏后是关闭的。',
      timeoutMs: TOOL_TIMEOUT.killaura,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['state', 'on', 'off', 'toggle', 'reload', 'config'],
            description: 'state=读状态；on/off/toggle=开关；reload=重读配置文件；config=按 config 对象更新配置',
          },
          config: {
            type: 'object',
            properties: {
              range: { type: 'number' },
              fov: { type: 'number' },
              minAttackCharge: { type: 'number' },
              rotation: { type: 'string', enum: ['silent', 'visible', 'none'] },
              priority: { type: 'string', enum: ['closest', 'lowestHealth', 'health', 'angle'] },
              targetPlayers: { type: 'boolean' },
              attackHostile: { type: 'boolean' },
              attackFriendlyDrops: { type: 'boolean' },
              attackFriendlyNoDrops: { type: 'boolean' },
              denyTargets: { type: 'array', items: { type: 'string' } },
              alwaysTargetsHigh: { type: 'array', items: { type: 'string' } },
              alwaysTargetsMedium: { type: 'array', items: { type: 'string' } },
              alwaysTargetsLow: { type: 'array', items: { type: 'string' } },
              alwaysTargetsLowest: { type: 'array', items: { type: 'string' } },
              targetArmorStands: { type: 'boolean' },
              ignoreInvisible: { type: 'boolean' },
              throughWalls: { type: 'boolean' },
              pauseInScreens: { type: 'boolean' },
              pauseWhileUsingItem: { type: 'boolean' },
            },
            additionalProperties: false,
            description:
              '仅 action=config 时使用：只改出现的字段（range 0.5–6.0、fov 1–360、minAttackCharge 0–1）；实体 ID 数组元素可省略 minecraft: 前缀；任一字段非法时整个请求 400、文件不改。',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async run(args, exec) {
        const action = enumValue(args.action, ['state', 'on', 'off', 'toggle', 'reload', 'config'], 'action');
        const config = args.config;
        if (action === 'config') {
          if (config === null || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length === 0) {
            throw new BridgeError('action=config 至少要给一个 config 字段。');
          }
          const body = await request('/ka/config', {
            method: 'POST',
            body: JSON.stringify(config),
            headers: { 'content-type': 'application/json' },
            timeoutMs: TIMEOUT.killaura,
            signal: exec.signal,
          });
          return prettyJson(body.trim());
        }
        if (config !== undefined) throw new BridgeError('config 只能和 action=config 一起用。');
        const body = await request(action === 'state' ? '/ka/state' : `/ka/${action}`, {
          method: action === 'state' ? 'GET' : 'POST',
          timeoutMs: TIMEOUT.killaura,
          signal: exec.signal,
        });
        return prettyJson(body.trim());
      },
    }),

    imageDefinition({
      name: 'mc_request',
      description:
        '直接调用游戏侧共享 HTTP 服务上任意以 / 开头的 endpoint，供以后新增、尚未封装成专用工具的接口使用。有专用工具（mc_status / mc_help / mc_player / mc_craft / mc_hotbar / mc_furnace / mc_chest / mc_look / mc_eat / mc_mine / mc_baritone / mc_killaura / mc_control 等）时优先用专用工具。endpoint 必须是相对路径，不能是完整 URL；非 2xx 会以错误结果返回状态码与模组原文。',
      timeoutMs: TOOL_TIMEOUT.request,
      parameters: {
        type: 'object',
        properties: {
          endpoint: {
            type: 'string',
            description:
              '相对路径，必须以 / 开头，可带 query，例如 `/ka/state`、`/bt/`、`/aif/info`。不要写协议或主机名。',
          },
          method: {
            type: 'string',
            enum: METHODS,
            description: 'HTTP 方法，默认 GET',
          },
          body: { type: 'string', description: '原样请求体；GET/HEAD 不能带 body' },
          headers: {
            type: 'array',
            items: { type: 'string' },
            description: '额外的请求头，每项写成 `Name: value`；例如 ["Accept: application/json"]',
          },
          contentType: {
            type: 'string',
            description: '带 body 且 headers 没指定 content-type 时使用，默认 text/plain; charset=utf-8',
          },
          timeoutMs: { type: 'integer', description: '超时（毫秒，默认 30000，夹到 1000–180000）' },
          responseType: {
            type: 'string',
            enum: ['auto', 'text', 'image', 'base64'],
            description:
              'auto（默认）按 content-type 自动识别图片；text 强制文本；image 强制图片；base64 返回原始字节的 base64',
          },
        },
        required: ['endpoint'],
        additionalProperties: false,
      },
      async run(args, exec) {
        const path = typeof args.endpoint === 'string' ? args.endpoint.trim() : '';
        if (!path.startsWith('/')) {
          throw new BridgeError(
            'endpoint 必须以 / 开头（例如 `/ka/state`），不能写完整 URL 或主机名。',
          );
        }

        const verb = enumValue(args.method, METHODS, 'method', 'GET').toUpperCase();
        if (args.body !== undefined && (verb === 'GET' || verb === 'HEAD')) {
          throw new BridgeError(`${verb} 请求不能带 body。`);
        }
        if (args.body !== undefined && typeof args.body !== 'string') {
          throw new BridgeError('body 必须是字符串。');
        }

        const requestHeaders = parseHeaderLines(args.headers);
        const hasContentType = Object.keys(requestHeaders).some(
          (name) => name.toLowerCase() === 'content-type',
        );
        if (args.body !== undefined && !hasContentType) {
          requestHeaders['content-type'] =
            typeof args.contentType === 'string' && args.contentType.length > 0
              ? args.contentType
              : 'text/plain; charset=utf-8';
        }

        const timeout = requestTimeout(args.timeoutMs);
        const response = await request.raw(path, {
          method: verb,
          body: args.body,
          headers: requestHeaders,
          timeoutMs: timeout,
          signal: exec.signal,
        });
        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > REQUEST_MAX_BYTES) {
          throw new BridgeError(`响应过大（${declaredLength} 字节，上限 ${REQUEST_MAX_BYTES}）。`);
        }

        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > REQUEST_MAX_BYTES) {
          throw new BridgeError(`响应过大（${bytes.length} 字节，上限 ${REQUEST_MAX_BYTES}）。`);
        }

        const type = (response.headers.get('content-type') ?? '').trim();
        const statusLine = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;

        if (!response.ok) {
          const hint = STATUS_HINT[response.status] ?? '';
          const detail = bytes.toString('utf8').trim();
          const lines = [`${statusLine}${hint ? ` ${hint}` : ''}`];
          if (type.length > 0) lines.push(`content-type: ${type}`);
          lines.push('', detail.length > 0 ? detail : '(空响应)');
          throw new BridgeError(lines.join('\n'));
        }

        const responseType = enumValue(
          args.responseType,
          ['auto', 'text', 'image', 'base64'],
          'responseType',
          'auto',
        );
        const isImage = type.toLowerCase().startsWith('image/');
        if (responseType === 'image' && !isImage) {
          throw new BridgeError(`响应不是图片（content-type: ${type || '未提供'}）。`);
        }
        if (responseType === 'base64') {
          return { text: bytes.toString('base64') };
        }
        if (responseType === 'image' || (responseType === 'auto' && isImage)) {
          const mediaType = type.split(';')[0].trim() || 'application/octet-stream';
          const admitted = await admitImage(ctx, exec, bytes, mediaType);
          const text = `${statusLine}，${bytes.length} 字节${type ? `（${type}）` : ''}`;
          if (admitted.ref === undefined) return { text: `${text}\n${admitted.diagnostic}` };
          return { text, image: admitted.ref };
        }

        const text = bytes.toString('utf8');
        return { text: text.length > 0 ? text : `${statusLine}（空响应）` };
      },
    }),
  ];

  const disposers = definitions.map((definition) => ctx.tools.register(definition));
  return () => {
    for (const dispose of disposers) dispose();
  };
}
