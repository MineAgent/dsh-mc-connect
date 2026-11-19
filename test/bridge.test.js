/**
 * dsh-mc-connect 直连桥的离线测试。
 *
 * 用真实 localhost HTTP 假服务替代 Minecraft 的 3420 接口，验证 19 个
 * mc_* 工具的参数、请求、错误路径与截图图片准入。
 *
 *   node --test test/bridge.test.js
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { registerBridgeTools } from '../bridge.js';

/** 1×1 PNG（IHDR 里宽高都是 1）。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);

/** 假 3420 服务。 */
let server;
let baseUrl;
let lastRequest;

before(async () => {
  server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      lastRequest = { method: request.method, url: request.url, body };
      const send = (status, text, type = 'text/plain; charset=utf-8') => {
        response.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text) });
        response.end(text);
      };
      if (request.method === 'HEAD') {
        response.writeHead(request.url === '/op/' ? 404 : 200);
        response.end();
        return;
      }
      if (request.url === '/') return send(200, '索引：/ctl /aif /op /bt /ka');
      if (request.url === '/aif/info') return send(200, '坐标 0 64 0');
      if (request.url === '/aif/inventory') return send(200, '石头 ×64');
      if (request.url === '/aif/world') return send(200, '主世界 白天');
      if (request.url === '/aif/msg') return send(200, '聊天一行');
      if (request.url === '/ctl/mouse') return send(200, '光标 10 20');
      if (request.url === '/ctl/prtsc') {
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
        response.end(PNG);
        return;
      }
      if (request.url === '/ctl/' && request.method === 'POST') {
        return send(200, JSON.stringify({ actions: ['W'], queued: 0, inWorld: true }));
      }
      if (request.url === '/op/' && request.method === 'POST') {
        if (body === 'eat 1') return send(200, '已食用 1 个');
        if (body === 'eat 3') return send(200, '已食用 3 个');
        if (body === 'mine') return send(200, '已破坏 石头');
        if (body.startsWith('craft ')) return send(200, '合成了 1 个');
        if (body.startsWith('inventory ')) return send(200, '已换到快捷栏');
        if (body.startsWith('furnace ')) return send(200, '熔炉操作完成');
        if (body.startsWith('chest ')) return send(200, '箱子操作完成');
        if (body.startsWith('look ')) return send(200, '已转向');
        return send(200, '合成了 1 个');
      }
      if (request.url === '/bt/' && request.method === 'POST') return send(200, '已接受');
      if (request.url === '/ka/state') return send(200, '{"enabled":false}');
      if (request.url === '/ka/config' && request.method === 'POST') {
        return send(200, JSON.stringify({ enabled: false, range: 4.5 }), 'application/json');
      }
      if (request.url === '/missing') return send(404, '没有这个接口');
      if (request.url === '/image') {
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
        response.end(PNG);
        return;
      }
      send(500, `未预期的请求 ${request.method} ${request.url}`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/**
 * 造一个只提供本插件所需能力的假 Context。
 * @param {object} [options] - 图片准入与模型能力。
 * @returns {object} 工具表与假服务。
 */
function fakeContext(options = {}) {
  const tools = new Map();
  const saved = [];
  const attachments =
    options.attachments === false
      ? undefined
      : {
          async saveImage(input) {
            saved.push(input);
            return {
              attachmentId: 'att-1',
              mediaType: input.mediaType,
              bytes: input.data.length,
              width: 1,
              height: 1,
            };
          },
        };
  const llm = {
    async resolveModelInfo() {
      return { inputModalities: options.imageCapable === false ? ['text'] : ['text', 'image'] };
    },
  };
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get(name) {
      if (name === 'attachments') return attachments;
      if (name === 'llm') return llm;
      return undefined;
    },
  };
  return { ctx, tools, saved };
}

/** 构造一次假执行。 */
function fakeExec() {
  return {
    signal: new AbortController().signal,
    agent: {
      options: { provider: 'fake-provider', model: 'fake-model' },
      session: {
        requestHeader() {
          return { config: { provider: 'fake-provider', model: 'fake-model' } };
        },
      },
    },
  };
}

/**
 * 加载工具并返回注册表。
 * @param {object} [options] - 透传给 fakeContext。
 * @returns {Promise<object>} 工具表。
 */
async function loadTools(options = {}) {
  const { ctx, tools, saved } = fakeContext(options);
  registerBridgeTools(ctx, { baseUrl });
  return { tools, saved, ctx };
}

test('注册 19 个 mc_* 工具，参数都是对象 schema', async () => {
  const { tools } = await loadTools();
  assert.deepEqual([...tools.keys()].sort(), [
    'mc_baritone',
    'mc_chat',
    'mc_chest',
    'mc_control',
    'mc_craft',
    'mc_cursor',
    'mc_eat',
    'mc_furnace',
    'mc_help',
    'mc_hotbar',
    'mc_inventory',
    'mc_killaura',
    'mc_look',
    'mc_mine',
    'mc_player',
    'mc_request',
    'mc_screenshot',
    'mc_status',
    'mc_world',
  ]);
  for (const definition of tools.values()) {
    assert.equal(definition.parameters.type, 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(definition.output.schema.type, 'object');
    assert.ok(definition.timeoutMs > 0);
  }
});

test('只读快照工具返回服务文本', async () => {
  const { tools } = await loadTools();
  const exec = fakeExec();
  for (const [name, expected] of [
    ['mc_player', '坐标 0 64 0'],
    ['mc_inventory', '石头 ×64'],
    ['mc_world', '主世界 白天'],
    ['mc_chat', '聊天一行'],
    ['mc_cursor', '光标 10 20'],
  ]) {
    const value = await tools.get(name).execute({}, exec);
    assert.equal(value.text, expected);
    assert.deepEqual(tools.get(name).output.render({}, value), [{ type: 'text', text: expected }]);
  }
});

test('mc_status 汇总接口挂载情况', async () => {
  const { tools } = await loadTools();
  const value = await tools.get('mc_status').execute({}, fakeExec());
  assert.match(value.text, /服务：http:\/\/127\.0\.0\.1:\d+ 可连接/);
  assert.match(value.text, /\/ctl 控制：可用/);
  assert.match(value.text, /\/op 容器操作：不可用/);
  assert.match(value.text, /世界：已进入世界/);
  assert.match(value.text, /接口索引：/);
});

test('mc_help 校验 prefix', async () => {
  const { tools } = await loadTools();
  await assert.rejects(
    () => tools.get('mc_help').execute({ prefix: 'nope' }, fakeExec()),
    /prefix 必须是/,
  );
});

test('mc_control 发 POST body、汇总动作并等待 waitMs', async () => {
  const { tools } = await loadTools();
  const value = await tools.get('mc_control').execute({ command: 'W 500', waitMs: 20 }, fakeExec());
  assert.equal(lastRequest.method, 'POST');
  assert.equal(lastRequest.url, '/ctl/');
  assert.equal(lastRequest.body, 'W 500');
  assert.match(value.text, /已接受 1 个动作/);
  assert.match(value.text, /已等待 20ms/);
});

test('mc_control 拒绝空命令，waitMs 被夹取', async () => {
  const { tools } = await loadTools();
  await assert.rejects(() => tools.get('mc_control').execute({ command: '  ' }, fakeExec()), /不能为空/);
  const value = await tools.get('mc_control').execute({ command: 'W', waitMs: -5 }, fakeExec());
  assert.doesNotMatch(value.text, /已等待/);
});

test('mc_baritone 发 POST', async () => {
  const { tools } = await loadTools();
  assert.equal(
    (await tools.get('mc_baritone').execute({ command: 'goal 0 64 0' }, fakeExec())).text,
    '已接受',
  );
  assert.equal(lastRequest.url, '/bt/');
});

test('mc_craft / mc_hotbar 发 POST 并校验参数', async () => {
  const { tools } = await loadTools();
  const exec = fakeExec();
  assert.equal((await tools.get('mc_craft').execute({ item: 'stone' }, exec)).text, '合成了 1 个');
  assert.equal(lastRequest.url, '/op/');
  assert.equal(lastRequest.body, 'craft stone 1');
  assert.equal(
    (await tools.get('mc_craft').execute({ item: 'minecraft:torch', amount: 16 }, exec)).text,
    '合成了 1 个',
  );
  assert.equal(lastRequest.body, 'craft minecraft:torch 16');
  await assert.rejects(() => tools.get('mc_craft').execute({}, exec), /item 不能为空/);
  await assert.rejects(
    () => tools.get('mc_craft').execute({ item: 'stone', amount: 0 }, exec),
    /amount 必须是 1–2304 的整数/,
  );
  assert.equal((await tools.get('mc_hotbar').execute({ item: 'torch' }, exec)).text, '已换到快捷栏');
  assert.equal(lastRequest.body, 'inventory torch 1');
  assert.equal((await tools.get('mc_hotbar').execute({ item: 'torch', slot: 9 }, exec)).text, '已换到快捷栏');
  assert.equal(lastRequest.body, 'inventory torch 9');
  await assert.rejects(
    () => tools.get('mc_hotbar').execute({ item: 'torch', slot: 10 }, exec),
    /slot 必须是 1–9 的整数/,
  );
});

test('mc_furnace / mc_chest 发 POST 并校验参数', async () => {
  const { tools } = await loadTools();
  const exec = fakeExec();
  assert.equal(
    (await tools.get('mc_furnace').execute({ action: 'put', slot: 'raw', item: 'raw_iron', amount: 8 }, exec))
      .text,
    '熔炉操作完成',
  );
  assert.equal(lastRequest.body, 'furnace put raw raw_iron 8');
  assert.equal(
    (await tools.get('mc_furnace').execute({ action: 'get', slot: 'product' }, exec)).text,
    '熔炉操作完成',
  );
  assert.equal(lastRequest.body, 'furnace get product 1');
  await assert.rejects(
    () => tools.get('mc_furnace').execute({ action: 'put', slot: 'product', item: 'coal' }, exec),
    /slot 只能是 raw\/fuel/,
  );
  await assert.rejects(
    () => tools.get('mc_furnace').execute({ action: 'get', slot: 'raw', item: 'coal' }, exec),
    /不接受 item/,
  );
  await assert.rejects(
    () => tools.get('mc_furnace').execute({ action: 'put', slot: 'raw' }, exec),
    /item 不能为空/,
  );
  assert.equal(
    (await tools.get('mc_chest').execute({ action: 'put', item: 'cobblestone', amount: 64 }, exec)).text,
    '箱子操作完成',
  );
  assert.equal(lastRequest.body, 'chest put cobblestone 64');
  assert.equal(
    (await tools.get('mc_chest').execute({ action: 'get', item: 'iron_ingot' }, exec)).text,
    '箱子操作完成',
  );
  assert.equal(lastRequest.body, 'chest get iron_ingot 1');
});

test('mc_look 发 POST 并校验轴', async () => {
  const { tools } = await loadTools();
  const exec = fakeExec();
  assert.equal((await tools.get('mc_look').execute({ axis: 'yaw', angle: '~-20' }, exec)).text, '已转向');
  assert.equal(lastRequest.url, '/op/');
  assert.equal(lastRequest.body, 'look yaw ~-20');
  assert.equal((await tools.get('mc_look').execute({ axis: 'pitch', angle: '90' }, exec)).text, '已转向');
  assert.equal(lastRequest.body, 'look pitch 90');
  await assert.rejects(
    () => tools.get('mc_look').execute({ axis: 'roll', angle: '0' }, exec),
    /axis 必须是 yaw\/pitch 之一/,
  );
});

test('mc_eat / mc_mine 发 POST，校验 eat 数量', async () => {
  const { tools } = await loadTools();
  const exec = fakeExec();
  assert.equal((await tools.get('mc_eat').execute({}, exec)).text, '已食用 1 个');
  assert.equal(lastRequest.method, 'POST');
  assert.equal(lastRequest.url, '/op/');
  assert.equal(lastRequest.body, 'eat 1');
  assert.equal((await tools.get('mc_eat').execute({ amount: 3 }, exec)).text, '已食用 3 个');
  assert.equal(lastRequest.body, 'eat 3');
  assert.equal((await tools.get('mc_mine').execute({}, exec)).text, '已破坏 石头');
  assert.equal(lastRequest.method, 'POST');
  assert.equal(lastRequest.url, '/op/');
  assert.equal(lastRequest.body, 'mine');
  for (const amount of [0, 1.5, 2305]) {
    await assert.rejects(
      () => tools.get('mc_eat').execute({ amount }, exec),
      /amount 必须是 1–2304 的整数/,
    );
  }
});

test('mc_killaura 读状态与更新配置', async () => {
  const { tools } = await loadTools();
  const exec = fakeExec();
  const state = await tools.get('mc_killaura').execute({ action: 'state' }, exec);
  assert.equal(state.text, JSON.stringify({ enabled: false }, null, 2));
  const config = await tools.get('mc_killaura').execute({ action: 'config', config: { range: 4.5 } }, exec);
  assert.equal(lastRequest.url, '/ka/config');
  assert.equal(lastRequest.body, '{"range":4.5}');
  assert.equal(config.text, JSON.stringify({ enabled: false, range: 4.5 }, null, 2));
  await assert.rejects(() => tools.get('mc_killaura').execute({ action: 'config' }, exec), /至少要给一个/);
});

test('mc_request 校验 endpoint、method、body 与 headers', async () => {
  const { tools } = await loadTools();
  const exec = fakeExec();
  await assert.rejects(() => tools.get('mc_request').execute({ endpoint: 'ka/state' }, exec), /必须以 \/ 开头/);
  await assert.rejects(
    () => tools.get('mc_request').execute({ endpoint: '/', method: 'GET', body: 'x' }, exec),
    /GET 请求不能带 body/,
  );
  await assert.rejects(
    () => tools.get('mc_request').execute({ endpoint: '/', headers: ['nope'] }, exec),
    /不是 "Name: value" 形式/,
  );
  const text = await tools.get('mc_request').execute({ endpoint: '/ka/state' }, exec);
  assert.equal(text.text, '{"enabled":false}');
});

test('mc_request 非 2xx 抛带状态码与正文的错误', async () => {
  const { tools } = await loadTools();
  await assert.rejects(
    () => tools.get('mc_request').execute({ endpoint: '/missing' }, fakeExec()),
    /HTTP 404 Not Found 路径不存在[\s\S]*没有这个接口/,
  );
});

test('mc_request responseType=base64 返回原始字节', async () => {
  const { tools } = await loadTools();
  const value = await tools.get('mc_request').execute(
    { endpoint: '/image', responseType: 'base64' },
    fakeExec(),
  );
  assert.equal(value.text, PNG.toString('base64'));
});

test('mc_screenshot 在模型支持图片时返回图片内容', async () => {
  const { tools, saved } = await loadTools();
  const exec = fakeExec();
  const value = await tools.get('mc_screenshot').execute({}, exec);
  assert.equal(value.text.includes('1×1'), true);
  assert.equal(value.image.attachmentId, 'att-1');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].mediaType, 'image/png');
  const content = tools.get('mc_screenshot').projectContent(exec, { isError: false, value });
  assert.deepEqual(content[0], {
    type: 'image',
    attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1 },
  });
  assert.equal(content[1].type, 'text');
});

test('mc_screenshot 在模型不支持图片时降级为文本诊断', async () => {
  const { tools, saved } = await loadTools({ imageCapable: false });
  const exec = fakeExec();
  const value = await tools.get('mc_screenshot').execute({}, exec);
  assert.equal(value.image, undefined);
  assert.match(value.text, /图片不可用：image\/png/);
  assert.match(value.text, /未声明图片输入/);
  assert.equal(saved.length, 0);
  assert.equal(tools.get('mc_screenshot').projectContent(exec, { isError: false, value }), undefined);
});

test('mc_screenshot 在没有附件存储时降级', async () => {
  const { tools } = await loadTools({ attachments: false });
  const value = await tools.get('mc_screenshot').execute({}, fakeExec());
  assert.equal(value.image, undefined);
  assert.match(value.text, /图片不可用/);
});

test('服务没开时给出可读中文错误', async () => {
  const { ctx, tools } = fakeContext();
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  registerBridgeTools(ctx, { baseUrl: `http://127.0.0.1:${port}` });
  await assert.rejects(
    () => tools.get('mc_player').execute({}, fakeExec()),
    /连不上 http:\/\/127\.0\.0\.1:\d+\/aif\/info：Minecraft 客户端没在运行/,
  );
});
