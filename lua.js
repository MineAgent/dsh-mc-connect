// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MineAgent
/**
 * dsh-mc-connect — advanced 订阅的 Lua 运行时。
 *
 * 每个 advanced 订阅对应一个常驻 system-lua 子进程。事件通过 stdin 以 JSON
 * 行送入，脚本用 stdout 上带每进程随机 `@@DSH:<token>@@` 前缀的 JSON 行回传命令：
 *
 *   host → lua   {"type":"event","event":...,"meta":...}
 *                {"type":"mc_result","id":1,"ok":true,"status":200,...}
 *                {"type":"end","reason":"max-events"}
 *   lua → host   {"cmd":"ready"}
 *                {"cmd":"send","text":"..."}
 *                {"cmd":"forward","event":...}
 *                {"cmd":"mc","id":1,"request":{...}}
 *                {"cmd":"log","text":"..."}
 *                {"cmd":"error","message":"..."}
 *
 * 本模块只负责进程、协议与临时脚本；`send`/`forward`/`mc` 的语义由
 * `events.js` 通过回调提供。用户脚本运行在 `build_environment` 构造的白名单
 * 环境里：没有 io/os/package/debug/load/require，stdout 只由 prelude 使用，
 * 且协议前缀带随机 token，脚本无法伪造宿主命令。
 *
 * @module dsh-mc-connect/lua
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** prelude 中等待替换为每进程随机协议前缀的占位符。 */
const PROTOCOL_PREFIX_PLACEHOLDER = '@@DSH_PREFIX_PLACEHOLDER@@';

/** 等待脚本加载并发出 ready 的最长时间。 */
const START_TIMEOUT_MS = 5_000;

/** 自动结束时等待脚本退出的最长时间。 */
const END_TIMEOUT_MS = 3_000;

/** 终止进程时每阶段的等待时间。 */
const KILL_TIMEOUT_MS = 1_000;

/** 单行协议/日志上限；超过视为脚本异常输出并终止。 */
const MAX_LINE_CHARS = 1024 * 1024;

/** stderr 只保留尾部这么多字符，用于启动失败诊断。 */
const MAX_STDERR_CHARS = 8_000;

/**
 * Lua 前置代码。保持 Lua 5.1+ 兼容：不使用 goto、位运算与 5.2 专有语法。
 *
 * 提供 JSON 编解码、stdin/stdout 协议、`send`/`forward`/`log`/`mc.*`，
 * 以及 `on_event` / `on_end` 分发循环。用户脚本以独立 chunk 加载，因此
 * 顶层 `return` 不会跳过分发循环。
 *
 * `build_environment` 构造只含白名单 API 的 sandbox 环境；`buildSource` 在
 * 加载用户脚本前清除宿主 io/os/package/debug/load 等全局，防止脚本逃逸。
 */
const LUA_PRELUDE = String.raw`
-- dsh-mc-connect generated prelude
local PROTOCOL_PREFIX = "${PROTOCOL_PREFIX_PLACEHOLDER}"
local json = {}

local function decode_error(message)
  error("JSON decode error: " .. tostring(message), 0)
end

local function skip_space(text, index)
  local _, last = string.find(text, "^[ \t\r\n]*", index)
  return (last or index - 1) + 1
end

local function utf8_char(code)
  if code < 0x80 then
    return string.char(code)
  elseif code < 0x800 then
    return string.char(0xC0 + math.floor(code / 0x40), 0x80 + (code % 0x40))
  elseif code < 0x10000 then
    return string.char(
      0xE0 + math.floor(code / 0x1000),
      0x80 + (math.floor(code / 0x40) % 0x40),
      0x80 + (code % 0x40)
    )
  end
  return string.char(
    0xF0 + math.floor(code / 0x40000),
    0x80 + (math.floor(code / 0x1000) % 0x40),
    0x80 + (math.floor(code / 0x40) % 0x40),
    0x80 + (code % 0x40)
  )
end

local function decode_string(text, index)
  local parts = {}
  local position = index + 1
  while true do
    local char = string.sub(text, position, position)
    if char == "" then decode_error("unterminated string") end
    if char == '"' then
      return table.concat(parts), position + 1
    elseif char == "\\" then
      local escape = string.sub(text, position + 1, position + 1)
      local simple = ({
        ['"'] = '"',
        ['\\'] = '\\',
        ['/'] = '/',
        b = '\b',
        f = '\f',
        n = '\n',
        r = '\r',
        t = '\t',
      })[escape]
      if simple ~= nil then
        parts[#parts + 1] = simple
        position = position + 2
      elseif escape == "u" then
        local hex = string.sub(text, position + 2, position + 5)
        local code = tonumber(hex, 16)
        if code == nil or #hex < 4 then decode_error("invalid unicode escape") end
        position = position + 6
        if code >= 0xD800 and code <= 0xDBFF then
          local marker = string.sub(text, position, position + 1)
          local low = tonumber(string.sub(text, position + 2, position + 5), 16)
          if marker == "\\u" and low ~= nil and low >= 0xDC00 and low <= 0xDFFF then
            code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
            position = position + 6
          end
        end
        parts[#parts + 1] = utf8_char(code)
      else
        decode_error("invalid escape sequence")
      end
    else
      parts[#parts + 1] = char
      position = position + 1
    end
  end
end

local function decode_number(text, index)
  local literal = string.match(text, "^-?%d+%.?%d*[eE]?[+-]?%d*", index)
  if literal == nil then decode_error("invalid number") end
  local value = tonumber(literal)
  if value == nil then decode_error("invalid number") end
  return value, index + #literal
end

json.decode = function(text)
  if type(text) ~= "string" then decode_error("input must be a string") end
  local parse_value

  local function parse(index)
    index = skip_space(text, index)
    local char = string.sub(text, index, index)
    if char == '"' then
      return decode_string(text, index)
    elseif char == "{" then
      local object = {}
      local position = skip_space(text, index + 1)
      if string.sub(text, position, position) == "}" then return object, position + 1 end
      while true do
        position = skip_space(text, position)
        if string.sub(text, position, position) ~= '"' then
          decode_error("expected an object key")
        end
        local key
        key, position = decode_string(text, position)
        position = skip_space(text, position)
        if string.sub(text, position, position) ~= ":" then decode_error("expected ':'") end
        local value
        value, position = parse(position + 1)
        object[key] = value
        position = skip_space(text, position)
        local delimiter = string.sub(text, position, position)
        if delimiter == "}" then return object, position + 1 end
        if delimiter ~= "," then decode_error("expected ',' or '}'") end
        position = position + 1
      end
    elseif char == "[" then
      local array = {}
      local position = skip_space(text, index + 1)
      if string.sub(text, position, position) == "]" then return array, position + 1 end
      while true do
        local value
        value, position = parse(position)
        array[#array + 1] = value
        position = skip_space(text, position)
        local delimiter = string.sub(text, position, position)
        if delimiter == "]" then return array, position + 1 end
        if delimiter ~= "," then decode_error("expected ',' or ']'") end
        position = position + 1
      end
    elseif string.sub(text, index, index + 3) == "true" then
      return true, index + 4
    elseif string.sub(text, index, index + 4) == "false" then
      return false, index + 5
    elseif string.sub(text, index, index + 3) == "null" then
      return nil, index + 4
    elseif char == "-" or string.find(char, "%d") then
      return decode_number(text, index)
    end
    decode_error("unexpected character at byte " .. tostring(index))
  end

  parse_value = parse
  local value, index = parse_value(1)
  index = skip_space(text, index)
  if index <= #text then decode_error("trailing characters") end
  return value
end

local escape_map = {
  ['"'] = '\\"',
  ['\\'] = '\\\\',
  ['\b'] = '\\b',
  ['\f'] = '\\f',
  ['\n'] = '\\n',
  ['\r'] = '\\r',
  ['\t'] = '\\t',
}

local function encode_string(value)
  local escaped = string.gsub(value, '[%c"\\]', function(char)
    local replacement = escape_map[char]
    if replacement ~= nil then return replacement end
    return string.format("\\u%04x", string.byte(char))
  end)
  return '"' .. escaped .. '"'
end

local function is_array(value)
  local count = #value
  if count == 0 then return false end
  local keys = 0
  for key in pairs(value) do
    if type(key) ~= "number" or key < 1 or key > count or key % 1 ~= 0 then
      return false
    end
    keys = keys + 1
  end
  return keys == count
end

local function encode_value(value, seen)
  local kind = type(value)
  if value == nil then
    return "null"
  elseif kind == "boolean" then
    return value and "true" or "false"
  elseif kind == "number" then
    if value ~= value or value == math.huge or value == -math.huge then return "null" end
    return string.format("%.17g", value)
  elseif kind == "string" then
    return encode_string(value)
  elseif kind == "table" then
    if seen[value] then error("cannot encode a cyclic table", 0) end
    seen[value] = true
    local parts = {}
    if is_array(value) then
      for index = 1, #value do
        parts[#parts + 1] = encode_value(value[index], seen)
      end
      seen[value] = nil
      return "[" .. table.concat(parts, ",") .. "]"
    end
    for key, item in pairs(value) do
      local key_name = type(key) == "string" and key or tostring(key)
      parts[#parts + 1] = encode_string(key_name) .. ":" .. encode_value(item, seen)
    end
    seen[value] = nil
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end

json.encode = function(value)
  return encode_value(value, {})
end

local stdin_stream = io.stdin
local stdout_stream = io.stdout

local function emit(message)
  stdout_stream:write(PROTOCOL_PREFIX, json.encode(message), "\n")
  stdout_stream:flush()
end

local pending = {}

local function read_message()
  local line = stdin_stream:read("*l")
  if line == nil then return nil end
  local ok, value = pcall(json.decode, line)
  if not ok or type(value) ~= "table" then
    emit({ cmd = "error", message = "cannot decode a host message: " .. tostring(value) })
    return read_message()
  end
  return value
end

local next_request_id = 0
local mc = {}

local function mc_request(spec)
  if type(spec) ~= "table" then error("mc.request expects a table", 0) end
  local path = spec.path or spec.url or "/"
  if type(path) ~= "string" or string.sub(path, 1, 1) ~= "/" then
    error("mc.request path must start with '/'", 0)
  end
  local method = string.upper(tostring(spec.method or "GET"))
  local body = spec.body
  if type(body) == "table" then body = json.encode(body) end
  next_request_id = next_request_id + 1
  local id = next_request_id
  emit({
    cmd = "mc",
    id = id,
    request = { method = method, path = path, body = body, headers = spec.headers },
  })
  while true do
    local message = read_message()
    if message == nil then
      error("the Lua host closed while waiting for an mc response", 0)
    end
    if message.type == "mc_result" and message.id == id then
      return message
    end
    if message.type == "event" or message.type == "end" then
      pending[#pending + 1] = message
      if #pending > 200 then table.remove(pending, 1) end
    end
  end
end

local function mc_get(path, headers)
  return mc_request({ method = "GET", path = path, headers = headers })
end

local function mc_post(path, body, headers)
  return mc_request({ method = "POST", path = path, body = body, headers = headers })
end

mc.request = mc_request
mc.get = mc_get
mc.post = mc_post

local function send(text)
  emit({ cmd = "send", text = tostring(text) })
end

local function forward(event)
  if type(event) ~= "table" then error("forward expects an event table", 0) end
  emit({ cmd = "forward", event = event })
end

local function log(text)
  emit({ cmd = "log", text = tostring(text) })
end

-- ── 白名单 sandbox ─────────────────────────────────────────────────────────

local STRING_NAMES = {
  "byte", "char", "find", "format", "gmatch", "gsub", "len", "lower",
  "match", "rep", "reverse", "sub", "upper", "pack", "packsize", "unpack",
}

local TABLE_NAMES = {
  "concat", "insert", "move", "pack", "remove", "sort", "unpack",
}

local MATH_NAMES = {
  "abs", "acos", "asin", "atan", "atan2", "ceil", "cos", "cosh", "deg",
  "exp", "floor", "fmod", "frexp", "huge", "ldexp", "log", "log10", "max",
  "maxinteger", "min", "mininteger", "modf", "pi", "pow", "rad", "random",
  "randomseed", "sin", "sinh", "sqrt", "tan", "tanh", "tointeger", "type",
  "ult",
}

local UTF8_NAMES = {
  "char", "charpattern", "codes", "codepoint", "len", "offset",
}

local OS_NAMES = {
  "clock", "date", "difftime", "time",
}

local function copy_allowed(module, names)
  local copy = {}
  if type(module) ~= "table" then return copy end
  for _, name in ipairs(names) do
    local value = module[name]
    if value ~= nil then copy[name] = value end
  end
  return copy
end

local function build_environment()
  local env = {
    assert = assert,
    error = error,
    ipairs = ipairs,
    pairs = pairs,
    next = next,
    select = select,
    tonumber = tonumber,
    tostring = tostring,
    type = type,
    pcall = pcall,
    xpcall = xpcall,
    rawget = rawget,
    rawset = rawset,
    rawequal = rawequal,
    _VERSION = _VERSION,
  }
  if rawlen ~= nil then env.rawlen = rawlen end
  if unpack ~= nil then env.unpack = unpack end
  if type(table) == "table" and type(table.unpack) == "function" then
    env.unpack = table.unpack
  end
  env.string = copy_allowed(string, STRING_NAMES)
  env.table = copy_allowed(table, TABLE_NAMES)
  env.math = copy_allowed(math, MATH_NAMES)
  if type(utf8) == "table" then env.utf8 = copy_allowed(utf8, UTF8_NAMES) end
  env.os = copy_allowed(os, OS_NAMES)
  env.send = send
  env.forward = forward
  env.log = log
  env.mc = copy_allowed(mc, { "request", "get", "post" })
  env.print = function(...)
    local parts = {}
    for index = 1, select("#", ...) do
      parts[#parts + 1] = tostring(select(index, ...))
    end
    log(table.concat(parts, "\t"))
  end

  local raw_setmetatable = setmetatable
  local raw_getmetatable = getmetatable
  env.setmetatable = function(target, meta)
    if type(target) ~= "table" then
      error("setmetatable is only allowed on tables", 2)
    end
    if meta ~= nil and type(meta) ~= "table" then
      error("setmetatable expects a table or nil", 2)
    end
    return raw_setmetatable(target, meta)
  end
  env.getmetatable = function(target)
    if type(target) ~= "table" then return nil end
    return raw_getmetatable(target)
  end
  return env
end

local function main(env)
  emit({ cmd = "ready" })
  while true do
    local message
    if #pending > 0 then
      message = table.remove(pending, 1)
    else
      message = read_message()
    end
    if message == nil then break end
    if message.type == "end" then
      local on_end = env.on_end
      if type(on_end) == "function" then
        local ok, err = pcall(on_end, tostring(message.reason or "ended"))
        if not ok then
          emit({ cmd = "error", message = "on_end failed: " .. tostring(err) })
        end
      end
      break
    elseif message.type == "event" then
      local on_event = env.on_event
      if type(on_event) == "function" then
        local ok, err = pcall(on_event, message.event, message.meta or {})
        if not ok then
          emit({ cmd = "error", message = "on_event failed: " .. tostring(err) })
        end
      end
    end
  end
end
`;

/**
 * 生成一段不会提前结束的 Lua 长括号字符串。
 * @param {string} text - 用户脚本。
 * @returns {string} Lua 字面量。
 */
function luaLongString(text) {
  let equals = '';
  while (text.includes(`]${equals}]`)) equals += '=';
  return `[${equals}[${text}]${equals}]`;
}

/**
 * 拼出临时脚本内容：prelude + 独立加载的用户脚本 + 分发循环。
 * @param {string} script - 用户脚本。
 * @param {string} protocolPrefix - 本次进程的随机协议前缀。
 * @returns {string} 完整 Lua 源码。
 */
function buildSource(script, protocolPrefix) {
  const prelude = LUA_PRELUDE.replace(PROTOCOL_PREFIX_PLACEHOLDER, protocolPrefix);
  return `${prelude}
-- user script
local __loadstring = loadstring
local __setfenv = setfenv
local __load = load
local __env = build_environment()
-- The user chunk only sees __env; remove the host globals it must never reach.
io = nil
os = nil
package = nil
debug = nil
require = nil
dofile = nil
loadfile = nil
load = nil
loadstring = nil
getfenv = nil
setfenv = nil
module = nil
newproxy = nil
coroutine = nil
collectgarbage = nil
print = nil
local __script = ${luaLongString(script)}
if string.sub(__script, 1, 1) == "\\27" then
  error("binary Lua chunks are not allowed", 0)
end
local __chunk, __load_error
if type(__loadstring) == "function" then
  if type(__setfenv) ~= "function" then
    error("the Lua sandbox cannot set the script environment", 0)
  end
  __chunk, __load_error = __loadstring(__script, "=dsh_lua_script")
  if __chunk ~= nil then __setfenv(__chunk, __env) end
else
  __chunk, __load_error = __load(__script, "=dsh_lua_script", "t", __env)
end
if __chunk == nil then error(__load_error, 0) end
local __ok, __script_error = pcall(__chunk)
if not __ok then error(__script_error, 0) end
main(__env)
`;
}

/**
 * 等待一段时间。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 一个常驻 Lua 脚本进程。
 */
export class LuaRuntime {
  /**
   * @param {object} options - 运行时选项。
   * @param {string} options.command - Lua 可执行文件。
   * @param {string} options.script - 用户脚本源码。
   * @param {object} [options.logger] - 插件 logger。
   * @param {(request: object) => Promise<object>} options.executeRequest - 执行 `mc.request`。
   * @param {(text: string) => Promise<void> | void} [options.onSend] - `send` 回调。
   * @param {(event: object) => Promise<void> | void} [options.onForward] - `forward` 回调。
   * @param {(info: object) => void} [options.onExit] - 非主动退出回调。
   */
  constructor(options) {
    this.command = options.command;
    this.script = options.script;
    this.logger = options.logger;
    this.executeRequest = options.executeRequest;
    this.onSend = options.onSend;
    this.onForward = options.onForward;
    this.onExit = options.onExit;

    this.child = undefined;
    this.protocolToken = randomBytes(16).toString('hex');
    this.protocolPrefix = `@@DSH:${this.protocolToken}@@`;
    this.tempDir = undefined;
    this.scriptPath = undefined;
    this.stderr = '';
    this.stdoutBuffer = '';
    this.ready = false;
    this.exited = false;
    this.exitHandled = false;
    this.stopping = false;
    this.startTimer = undefined;
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    this.commandChain = Promise.resolve();
  }

  /**
   * 写入临时脚本并启动子进程，等待脚本发出 ready。
   * @returns {Promise<void>} ready 时 resolve。
   */
  async start() {
    if (this.ready) return;
    this.tempDir = mkdtempSync(join(tmpdir(), 'dsh-mc-connect-lua-'));
    this.scriptPath = join(this.tempDir, 'handler.lua');
    try {
      writeFileSync(this.scriptPath, buildSource(this.script, this.protocolPrefix), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (error) {
      this.cleanup();
      throw new Error(
        `mc-connect: cannot write the Lua script: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    const childEnv = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    };
    if (process.env.LANG !== undefined) childEnv.LANG = process.env.LANG;
    if (process.env.LC_ALL !== undefined) childEnv.LC_ALL = process.env.LC_ALL;
    if (process.platform === 'win32') {
      for (const key of ['SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR', 'TEMP', 'TMP']) {
        if (process.env[key] !== undefined) childEnv[key] = process.env[key];
      }
    }

    try {
      this.child = spawn(this.command, [this.scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: this.tempDir,
        env: childEnv,
      });
    } catch (error) {
      this.cleanup();
      throw new Error(
        `mc-connect: cannot start Lua (${this.command}): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const child = this.child;
    child.once('error', (error) => this.failStart(error));
    child.once('close', (code, signal) => this.handleExit(code, signal));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
      this.logger?.debug?.(`mc-connect lua stderr: ${String(chunk).trim()}`);
    });
    child.stdin.on('error', (error) => {
      if (!this.stopping) {
        this.logger?.warn?.(`mc-connect: Lua stdin error: ${String(error)}`);
      }
    });

    this.startTimer = setTimeout(() => {
      this.failStart(new Error(`Lua did not become ready within ${START_TIMEOUT_MS} ms`));
    }, START_TIMEOUT_MS);
    this.startTimer.unref?.();

    return readyPromise;
  }

  /**
   * 等待已经收到的 Lua 命令全部处理完。
   * @returns {Promise<void>}
   */
  async whenIdle() {
    await this.commandChain.catch(() => {});
  }

  /**
   * 把一条事件写入 Lua stdin。
   * @param {object} event - 事件表。
   * @param {object} meta - 订阅元数据。
   * @returns {Promise<boolean>} 是否写入成功。
   */
  writeEvent(event, meta) {
    return this.writeLine(`${JSON.stringify({ type: 'event', event, meta })}\n`);
  }

  /**
   * 自动结束：先让脚本处理已排队的事件，再发送 end 并等待退出。
   * @param {string} reason - 结束原因。
   * @returns {Promise<void>}
   */
  async end(reason) {
    if (this.exited) {
      this.cleanup();
      return;
    }
    this.stopping = true;
    clearTimeout(this.startTimer);
    await this.writeLine(`${JSON.stringify({ type: 'end', reason })}\n`);
    await this.waitExit(END_TIMEOUT_MS);
    if (!this.exited) await this.terminate();
    this.cleanup();
  }

  /**
   * 立即终止：结束 stdin，必要时 SIGTERM / SIGKILL。
   * @returns {Promise<void>}
   */
  async terminate() {
    this.stopping = true;
    clearTimeout(this.startTimer);
    if (this.exited) {
      this.cleanup();
      return;
    }
    this.kill('SIGTERM');
    await this.waitExit(KILL_TIMEOUT_MS);
    if (!this.exited) {
      this.kill('SIGKILL');
      await this.waitExit(KILL_TIMEOUT_MS);
    }
    this.cleanup();
  }

  /**
   * 写入一行；处理 `drain` 与 `error`。
   * @param {string} line - 完整行。
   * @returns {Promise<boolean>} 是否写入。
   */
  writeLine(line) {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable || this.exited) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const cleanup = () => {
        stdin.off('drain', finish);
        stdin.off('error', fail);
        if (timer !== undefined) clearTimeout(timer);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(true);
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };
      try {
        if (stdin.write(line)) {
          finish();
          return;
        }
        stdin.once('drain', finish);
        stdin.once('error', fail);
        timer = setTimeout(fail, 5_000);
        timer.unref?.();
      } catch {
        fail();
      }
    });
  }

  /**
   * 处理 stdout 数据，按行分发。
   * @param {string} chunk - 文本块。
   */
  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line.length > MAX_LINE_CHARS) {
        this.logger?.warn?.('mc-connect: Lua produced an oversized output line; terminating the script');
        void this.terminate();
        return;
      }
      this.handleLine(line);
      index = this.stdoutBuffer.indexOf('\n');
    }
    if (this.stdoutBuffer.length > MAX_LINE_CHARS) {
      this.logger?.warn?.('mc-connect: Lua produced an oversized output line; terminating the script');
      void this.terminate();
    }
  }

  /**
   * 处理一行 Lua 输出。
   * @param {string} line - 去掉换行的一行。
   */
  handleLine(line) {
    if (line.startsWith(this.protocolPrefix)) {
      let command;
      try {
        command = JSON.parse(line.slice(this.protocolPrefix.length));
      } catch (error) {
        this.logger?.warn?.(`mc-connect: cannot parse a Lua command: ${String(error)}`);
        return;
      }
      if (command === null || typeof command !== 'object' || typeof command.cmd !== 'string') {
        this.logger?.warn?.('mc-connect: Lua sent a malformed command');
        return;
      }
      this.commandChain = this.commandChain
        .then(() => this.dispatchCommand(command))
        .catch((error) => {
          this.logger?.warn?.(`mc-connect: Lua command failed: ${String(error)}`);
        });
      return;
    }
    const text = line.trim();
    if (text.length > 0) {
      this.logger?.info?.(`mc-connect lua: ${text.slice(0, 2_000)}`);
    }
  }

  /**
   * 执行一条 Lua 回传命令。
   * @param {object} command - 命令对象。
   * @returns {Promise<void>}
   */
  async dispatchCommand(command) {
    if (command.cmd === 'ready') {
      this.ready = true;
      clearTimeout(this.startTimer);
      const resolve = this.resolveReady;
      this.resolveReady = undefined;
      this.rejectReady = undefined;
      resolve?.();
      return;
    }
    if (command.cmd === 'send') {
      await this.onSend?.(typeof command.text === 'string' ? command.text : String(command.text ?? ''));
      return;
    }
    if (command.cmd === 'forward') {
      await this.onForward?.(command.event);
      return;
    }
    if (command.cmd === 'log') {
      this.logger?.info?.(`mc-connect lua: ${String(command.text ?? '')}`);
      return;
    }
    if (command.cmd === 'error') {
      this.logger?.warn?.(`mc-connect lua: ${String(command.message ?? 'unknown script error')}`);
      return;
    }
    if (command.cmd === 'mc') {
      const id = command.id;
      const request =
        command.request !== null && typeof command.request === 'object' ? command.request : {};
      let result;
      try {
        result = await this.executeRequest(request);
        if (result === null || typeof result !== 'object') {
          result = { ok: false, error: 'empty response' };
        }
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await this.writeLine(`${JSON.stringify({ type: 'mc_result', id, ...result })}\n`);
      return;
    }
    this.logger?.warn?.(`mc-connect: unknown Lua command "${String(command.cmd)}"`);
  }

  /**
   * 启动失败：清理并 reject ready promise。
   * @param {Error} error - 失败原因。
   */
  failStart(error) {
    if (this.ready || this.exited) return;
    this.stopping = true;
    clearTimeout(this.startTimer);
    const detail = this.stderr.trim();
    const reject = this.rejectReady;
    this.rejectReady = undefined;
    this.resolveReady = undefined;
    reject?.(
      new Error(
        `mc-connect: cannot start Lua (${this.command}): ${error instanceof Error ? error.message : String(error)}` +
          (detail.length > 0 ? `\n${detail}` : ''),
        { cause: error },
      ),
    );
    this.kill('SIGKILL');
    this.cleanup();
  }

  /**
   * 子进程退出。
   * @param {number | null} code - 退出码。
   * @param {string | null} signal - 信号。
   */
  handleExit(code, signal) {
    if (this.exitHandled) return;
    this.exitHandled = true;
    this.exited = true;
    clearTimeout(this.startTimer);
    this.cleanup();
    if (!this.ready) {
      const reject = this.rejectReady;
      this.rejectReady = undefined;
      this.resolveReady = undefined;
      const detail = this.stderr.trim();
      reject?.(
        new Error(
          `mc-connect: Lua exited before it became ready (code ${String(code)}, signal ${String(signal)})` +
            (detail.length > 0 ? `\n${detail}` : ''),
        ),
      );
      return;
    }
    if (!this.stopping) {
      try {
        this.onExit?.({ code, signal, stderr: this.stderr.trim() });
      } catch (error) {
        this.logger?.warn?.(`mc-connect: Lua exit handler failed: ${String(error)}`);
      }
    }
  }

  /**
   * 结束 stdin 并发送信号。
   * @param {NodeJS.Signals} signal - 信号。
   */
  kill(signal) {
    const child = this.child;
    if (child === undefined) return;
    try {
      child.stdin?.end();
    } catch {
      // 忽略：进程可能已经退出。
    }
    try {
      child.kill(signal);
    } catch {
      // 忽略：进程可能已经退出。
    }
  }

  /**
   * 等待进程退出。
   * @param {number} timeoutMs - 最长等待毫秒数。
   * @returns {Promise<void>}
   */
  async waitExit(timeoutMs) {
    const started = Date.now();
    while (!this.exited && Date.now() - started < timeoutMs) {
      await sleep(10);
    }
  }

  /**
   * 删除临时脚本目录。
   */
  cleanup() {
    if (this.tempDir === undefined) return;
    const directory = this.tempDir;
    this.tempDir = undefined;
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      this.logger?.warn?.(`mc-connect: cannot remove the Lua temp directory: ${String(error)}`);
    }
  }
}

/**
 * 创建一个 Lua 运行时实例。
 * @param {object} options - 见 {@link LuaRuntime}。
 * @returns {LuaRuntime} 运行时。
 */
export function createLuaRuntime(options) {
  return new LuaRuntime(options);
}
