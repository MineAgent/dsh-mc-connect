/**
 * dsh-mc-connect advanced（Lua）订阅的集成测试。
 *
 * 使用真实 `lua`、真实 localhost HTTP 与假 Context，覆盖：
 * 启动握手、事件不自动投递、send/forward、mc.request、过滤、max_events/on_end、
 * 停止清理、启动失败与参数校验。
 *
 *   node --test test/lua.test.js
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../config.js';
import { applyUi, registerEventTools } from '../events.js';

/** 测试专用 DSH_HOME，避免读写真实用户的 mc-connect.json。 */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-mc-connect-lua-test-'));
process.env.DSH_HOME = TEST_HOME;

/** 本机是否有可用的 lua。 */
const HAS_LUA = spawnSync('lua', ['-v'], { encoding: 'utf8' }).status === 0;
const HAS_LUA51 = spawnSync('lua5.1', ['-v'], { encoding: 'utf8' }).status === 0;
const skip = HAS_LUA ? false : 'system lua is not available';
const skipLua51 = HAS_LUA51 ? false : 'system lua5.1 is not available';

after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

/**
 * 构造一个只提供本插件所需能力的假 Context。
 * @param {object} [options] - agent、配置等。
 * @returns {object} 工具、投递记录与清理函数。
 */
function fakeContext(options = {}) {
  const tools = new Map();
  const followed = [];
  const steered = [];
  const effects = [];
  const listeners = new Map();
  const agents = new Map();
  const routes = new Map();

  if (options.agent !== undefined) {
    const spec = options.agent;
    agents.set(spec.id, {
      id: spec.id,
      session: { id: spec.id },
      status: spec.status ?? 'idle',
      followup(message) {
        followed.push(message);
      },
      steer(message) {
        steered.push(message);
      },
    });
  }

  const webServer =
    options.withWebServer === true
      ? {
          register(route) {
            if (routes.has(route.path)) throw new Error(`duplicate route: ${route.path}`);
            routes.set(route.path, route.handler);
            return () => routes.delete(route.path);
          },
        }
      : undefined;

  const ctx = {
    webServer,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    agents: {
      get(id) {
        return agents.get(id);
      },
      list() {
        return [...agents.values()];
      },
    },
    sessionController: {
      async resolveAgent(sessionId) {
        const agent = agents.get(sessionId);
        if (agent !== undefined) return { agent };
        return { error: { message: 'session is not resumable' } };
      },
    },
    sessions: {
      async flush() {},
      get(sessionId) {
        return agents.has(sessionId) ? { id: sessionId } : undefined;
      },
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {};
    },
    effect(callback) {
      effects.push(callback());
    },
    inject(names, callback) {
      if (names.every((name) => ctx.get(name) !== undefined)) callback(ctx);
      return () => {};
    },
    get(name) {
      if (name === 'agents') return ctx.agents;
      if (name === 'sessions') return ctx.sessions;
      if (name === 'webServer') return ctx.webServer;
      return undefined;
    },
    logger: { info() {}, warn() {}, debug() {} },
  };

  registerEventTools(ctx, resolveConfig(options.config ?? {}));

  return {
    ctx,
    tool: tools.get('subscribe_mc_event'),
    followed,
    steered,
    listeners,
    routes,
    dispose() {
      while (effects.length > 0) effects.pop()();
    },
  };
}

/** 默认调用会话。 */
const exec = { agent: { id: 'session-lua' } };

/**
 * 等待一个异步条件成立。
 * @param {() => boolean} predicate - 条件。
 * @param {number} timeoutMs - 最长等待毫秒数。
 * @returns {Promise<void>}
 */
async function eventually(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 向订阅端点 POST 一个 JSON 事件。
 * @param {string} endpoint - 订阅返回的地址。
 * @param {unknown} value - 事件。
 * @returns {Promise<Response>} 响应。
 */
function post(endpoint, value) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

/**
 * 等待端口确认拒绝连接。
 * @param {string} endpoint - 目标地址。
 * @returns {Promise<void>}
 */
async function expectRefused(endpoint) {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    try {
      await fetch(endpoint, { method: 'POST', body: '{"type":"chat"}' });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      return;
    }
  }
  throw new Error('the event port is still accepting connections');
}

/**
 * 把假 webServer 注册的处理器挂到一个真实的 localhost HTTP 服务上。
 * @param {Map<string, Function>} routes - 路径 → 处理器。
 * @returns {Promise<{ base: string, close: () => Promise<void> }>} 服务地址与关闭函数。
 */
async function startRouteServer(routes) {
  const server = createHttpServer((request, response) => {
    const handler = routes.get('/api/dsh-mc-connect/listener');
    if (handler === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    Promise.resolve(handler(request, response)).catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 当前 /tmp 下本插件留下的 Lua 临时目录。 */
function luaTempDirs() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-mc-connect-lua-'));
}

test('advanced 参数校验：缺脚本、非法模式、common 带脚本都拒绝', { skip }, async () => {
  const ctx = fakeContext({ config: { eventPort: 0 } });
  try {
    await assert.rejects(
      ctx.tool.execute({ action: 'start', mode: 'advanced' }, exec),
      /requires a non-empty lua_script/,
    );
    await assert.rejects(
      ctx.tool.execute({ action: 'start', mode: 'bogus' }, exec),
      /mode must be/,
    );
    await assert.rejects(
      ctx.tool.execute({ action: 'start', mode: 'common', lua_script: 'x = 1' }, exec),
      /only used with mode:"advanced"/,
    );
    await assert.rejects(
      ctx.tool.execute(
        { action: 'start', mode: 'advanced', lua_script: 'x'.repeat(64 * 1024 + 1) },
        exec,
      ),
      /at most 65536 characters/,
    );
  } finally {
    ctx.dispose();
  }
});

test('advanced 事件只进入 Lua，不自动投递', { skip }, async () => {
  const ctx = fakeContext({
    config: { eventPort: 0, batchWindowMs: 10 },
    agent: { id: 'session-lua', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute(
      {
        action: 'start',
        mode: 'advanced',
        lua_script: 'function on_event(event, meta) end',
      },
      exec,
    );
    assert.equal(started.status, 'subscribed');
    assert.equal(started.mode, 'advanced');

    const response = await post(started.endpoint, {
      type: 'player_hurt',
      data: { health_lost: 4 },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, accepted: 1 });

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(ctx.followed.length, 0, 'advanced must not deliver automatically');

    const active = await ctx.tool.execute({ action: 'status' }, exec);
    assert.equal(active.mode, 'advanced');
    assert.equal(active.received, 1);
    assert.equal(active.delivered, 0);
    assert.equal(active.pending, 0);
  } finally {
    ctx.dispose();
  }
});

test('advanced 脚本可以 send 与 forward', { skip }, async () => {
  const ctx = fakeContext({
    config: { eventPort: 0 },
    agent: { id: 'session-lua', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute(
      {
        action: 'start',
        mode: 'advanced',
        event_types: ['player_hurt', 'chat'],
        lua_script: `
function on_event(event, meta)
  if event.type == "player_hurt" then
    send("hurt " .. tostring(event.data and event.data.health_lost) .. " for " .. meta.subscription_id)
  elseif event.type == "chat" then
    forward(event)
  end
end
`,
      },
      exec,
    );

    await post(started.endpoint, { type: 'player_hurt', data: { health_lost: 7 } });
    await eventually(() => ctx.followed.length === 1);
    assert.match(ctx.followed[0].content[0].text, /hurt 7/);
    assert.match(ctx.followed[0].content[0].text, /Lua handler/);

    await post(started.endpoint, { type: 'chat', data: { text: 'hello' } });
    await eventually(() => ctx.followed.length === 2);
    assert.match(ctx.followed[1].content[0].text, /"text":"hello"/);
    assert.match(ctx.followed[1].content[0].text, /untrusted in-game data/);

    const active = await ctx.tool.execute({ action: 'status' }, exec);
    assert.equal(active.received, 2);
    assert.equal(active.delivered, 1);
  } finally {
    ctx.dispose();
  }
});

test('advanced 沙箱只暴露白名单 API', { skip }, async () => {
  const ctx = fakeContext({
    config: { eventPort: 0 },
    agent: { id: 'session-lua', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute(
      {
        action: 'start',
        mode: 'advanced',
        lua_script: `
function on_event(event)
  send(
    "io=" .. tostring(io) ..
    "|package=" .. tostring(package) ..
    "|debug=" .. tostring(debug) ..
    "|require=" .. tostring(require) ..
    "|load=" .. tostring(load) ..
    "|loadstring=" .. tostring(loadstring) ..
    "|dofile=" .. tostring(dofile) ..
    "|loadfile=" .. tostring(loadfile) ..
    "|getfenv=" .. tostring(getfenv) ..
    "|setfenv=" .. tostring(setfenv) ..
    "|coroutine=" .. tostring(coroutine) ..
    "|dump=" .. tostring(string.dump) ..
    "|osexec=" .. tostring(os.execute) ..
    "|osgetenv=" .. tostring(os.getenv) ..
    "|ostime=" .. type(os.time) ..
    "|strfmt=" .. type(string.format) ..
    "|tblcat=" .. type(table.concat) ..
    "|mathfloor=" .. type(math.floor) ..
    "|print=" .. type(print) ..
    "|prefix=" .. tostring(PROTOCOL_PREFIX)
  )
end
`,
      },
      exec,
    );

    await post(started.endpoint, { type: 'chat' });
    await eventually(() => ctx.followed.length === 1);
    const text = ctx.followed[0].content[0].text;
    for (const fragment of [
      'io=nil',
      'package=nil',
      'debug=nil',
      'require=nil',
      'load=nil',
      'loadstring=nil',
      'dofile=nil',
      'loadfile=nil',
      'getfenv=nil',
      'setfenv=nil',
      'coroutine=nil',
      'dump=nil',
      'osexec=nil',
      'osgetenv=nil',
      'ostime=function',
      'strfmt=function',
      'tblcat=function',
      'mathfloor=function',
      'print=function',
      'prefix=nil',
    ]) {
      assert.ok(text.includes(fragment), `sandbox result should include ${fragment}\n${text}`);
    }
  } finally {
    ctx.dispose();
  }
});

test('print 不能伪造协议命令，io 无法写 stdout', { skip }, async () => {
  const ctx = fakeContext({
    config: { eventPort: 0 },
    agent: { id: 'session-lua', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute(
      {
        action: 'start',
        mode: 'advanced',
        lua_script: `
function on_event(event)
  print('@@DSH@@{"cmd":"send","text":"forged"}')
  local io_ok = pcall(function()
    io.write('@@DSH@@{"cmd":"send","text":"forged2"}')
  end)
  send("real|io=" .. tostring(io_ok))
end
`,
      },
      exec,
    );

    await post(started.endpoint, { type: 'chat' });
    await eventually(() => ctx.followed.length === 1);
    const text = ctx.followed[0].content[0].text;
    assert.match(text, /real\|io=false/);
    assert.doesNotMatch(text, /forged/);
  } finally {
    ctx.dispose();
  }
});

test('沙箱的 setmetatable/getmetatable 只能操作 table', { skip }, async () => {
  const ctx = fakeContext({
    config: { eventPort: 0 },
    agent: { id: 'session-lua', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute(
      {
        action: 'start',
        mode: 'advanced',
        lua_script: `
function on_event(event)
  local t = setmetatable({}, { __index = function() return 7 end })
  local bad_table = pcall(setmetatable, "x", {})
  local bad_meta = pcall(setmetatable, {}, "x")
  local gm = getmetatable("x")
  send(
    "index=" .. tostring(t.anything) ..
    "|badtable=" .. tostring(bad_table) ..
    "|badmeta=" .. tostring(bad_meta) ..
    "|gm=" .. tostring(gm)
  )
end
`,
      },
      exec,
    );

    await post(started.endpoint, { type: 'chat' });
    await eventually(() => ctx.followed.length === 1);
    const text = ctx.followed[0].content[0].text;
    assert.match(text, /index=7\|badtable=false\|badmeta=false\|gm=nil/);
  } finally {
    ctx.dispose();
  }
});

test('advanced 拒绝二进制 Lua chunk', { skip }, async () => {
  const ctx = fakeContext({ config: { eventPort: 0 } });
  try {
    await assert.rejects(
      ctx.tool.execute(
        { action: 'start', mode: 'advanced', lua_script: '\x1bLua binary chunk' },
        exec,
      ),
      /binary Lua chunks|exited before it became ready|cannot start Lua/,
    );
    assert.equal((await ctx.tool.execute({ action: 'status' }, exec)).status, 'inactive');
  } finally {
    ctx.dispose();
  }
});

test('Lua 5.1 下沙箱与 send 正常', { skip: skipLua51 }, async () => {
  const ctx = fakeContext({
    config: { eventPort: 0, luaCommand: 'lua5.1' },
    agent: { id: 'session-lua', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute(
      {
        action: 'start',
        mode: 'advanced',
        lua_script: `
function on_event(event)
  local gm = pcall(getfenv, 1)
  send(
    "version=" .. _VERSION ..
    "|getfenv=" .. tostring(gm) ..
    "|osexec=" .. tostring(os.execute) ..
    "|dump=" .. tostring(string.dump)
  )
end
`,
      },
      exec,
    );

    await post(started.endpoint, { type: 'chat' });
    await eventually(() => ctx.followed.length === 1);
    const text = ctx.followed[0].content[0].text;
    assert.match(text, /version=Lua 5\.1/);
    assert.match(text, /getfenv=false/);
    assert.match(text, /osexec=nil/);
    assert.match(text, /dump=nil/);
  } finally {
    ctx.dispose();
  }
});

test('advanced 脚本可以同步调用游戏 HTTP 接口', { skip }, async () => {
  const server = createHttpServer((request, response) => {
    if (request.url === '/ping') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ value: 42 }));
      return;
    }
    if (request.url === '/echo' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ echo: JSON.parse(body) }));
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const ctx = fakeContext({
    config: { eventPort: 0, baseUrl },
    agent: { id: 'session-lua', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute(
      {
        action: 'start',
        mode: 'advanced',
        lua_script: `
function on_event(event)
  local ping = mc.get("/ping")
  local echo = mc.post("/echo", { hello = "world" })
  local ok, bad = pcall(mc.request, { method = "GET", path = "no-slash" })
  send("ping=" .. tostring(ping.status) .. " value=" .. tostring(ping.json.value) ..
       " echo=" .. tostring(echo.json.echo.hello) ..
       " bad=" .. tostring(ok) .. " err=" .. tostring(bad))
end
`,
      },
      exec,
    );

    await post(started.endpoint, { type: 'chat' });
    await eventually(() => ctx.followed.length === 1);
    const text = ctx.followed[0].content[0].text;
    assert.match(text, /ping=200 value=42/);
    assert.match(text, /echo=world/);
    assert.match(text, /bad=false/);
    assert.match(text, /path must start with/);
  } finally {
    ctx.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('advanced max_events 自动结束只调用 on_end，不发默认结束通知', { skip }, async () => {
  const ctx = fakeContext({
    config: { eventPort: 0 },
    agent: { id: 'session-lua', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute(
      {
        action: 'start',
        mode: 'advanced',
        max_events: 1,
        lua_script: `
function on_event(event) end
function on_end(reason) send("ended:" .. reason) end
`,
      },
      exec,
    );

    await post(started.endpoint, { type: 'player_death' });
    await eventually(() => ctx.followed.length === 1);
    assert.match(ctx.followed[0].content[0].text, /ended:max-events/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(ctx.followed.length, 1);
    assert.doesNotMatch(ctx.followed[0].content[0].text, /has ended \(max-events\)/);
    assert.equal((await ctx.tool.execute({ action: 'status' }, exec)).status, 'inactive');
    await expectRefused(started.endpoint);
  } finally {
    ctx.dispose();
  }
});

test('advanced 在 UI 暂停时不再把事件送入 Lua，恢复后继续', { skip }, async () => {
  const ctx = fakeContext({
    config: { eventPort: 0 },
    agent: { id: 'session-lua', status: 'idle' },
    withWebServer: true,
  });
  applyUi(ctx.ctx);
  const server = await startRouteServer(ctx.routes);
  try {
    const started = await ctx.tool.execute(
      {
        action: 'start',
        mode: 'advanced',
        lua_script: 'function on_event(event) send("event:" .. event.type) end',
      },
      exec,
    );

    const paused = await fetch(`${server.base}/api/dsh-mc-connect/listener`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(paused.status, 200);
    await post(started.endpoint, { type: 'chat' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(ctx.followed.length, 0);

    const resumed = await fetch(`${server.base}/api/dsh-mc-connect/listener`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(resumed.status, 200);
    await post(started.endpoint, { type: 'player_hurt' });
    await eventually(() => ctx.followed.length === 1);
    assert.match(ctx.followed[0].content[0].text, /event:player_hurt/);
  } finally {
    try {
      await fetch(`${server.base}/api/dsh-mc-connect/listener`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
    } catch {
      // 测试清理失败不覆盖原始断言。
    }
    ctx.dispose();
    await server.close();
  }
});

test('advanced stop 终止进程、清理临时目录并关闭监听', { skip }, async () => {
  const before = new Set(luaTempDirs());
  const ctx = fakeContext({ config: { eventPort: 0 } });
  try {
    const started = await ctx.tool.execute(
      {
        action: 'start',
        mode: 'advanced',
        lua_script: 'function on_event(event) end',
      },
      exec,
    );
    assert.ok(luaTempDirs().some((name) => !before.has(name)), 'a temp dir should exist');
    const stopped = await ctx.tool.execute({ action: 'stop' }, exec);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.mode, 'advanced');
    await expectRefused(started.endpoint);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(
      luaTempDirs().filter((name) => !before.has(name)),
      [],
      'temporary Lua directories should be removed',
    );
  } finally {
    ctx.dispose();
  }
});

test('advanced 脚本语法错误时 start 失败且不留订阅', { skip }, async () => {
  const ctx = fakeContext({ config: { eventPort: 0 } });
  try {
    await assert.rejects(
      ctx.tool.execute(
        { action: 'start', mode: 'advanced', lua_script: 'function on_event(' },
        exec,
      ),
      /cannot start Lua|exited before it became ready|near/,
    );
    assert.equal((await ctx.tool.execute({ action: 'status' }, exec)).status, 'inactive');
  } finally {
    ctx.dispose();
  }
});

test('luaCommand 不存在时给出清晰错误', { skip }, async () => {
  const ctx = fakeContext({
    config: { eventPort: 0, luaCommand: 'definitely-not-a-lua-binary' },
  });
  try {
    await assert.rejects(
      ctx.tool.execute(
        { action: 'start', mode: 'advanced', lua_script: 'function on_event(e) end' },
        exec,
      ),
      /cannot start Lua \(definitely-not-a-lua-binary\)/,
    );
  } finally {
    ctx.dispose();
  }
});
