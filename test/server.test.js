import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server.js';
import { PlanStore } from '../lib/store.js';
import { OcrUnavailableError } from '../lib/ocr.js';

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function fakeOcr({ text = '', available = true } = {}) {
  return {
    status: async () => ({
      available,
      version: available ? 'fake-tesseract 5' : null,
      languages: available ? ['chi_sim', 'eng'] : [],
      lang: available ? 'chi_sim+eng' : null,
      ...(available ? {} : { reason: '未找到 tesseract 可执行文件' }),
    }),
    recognize: async () => {
      if (!available) throw new OcrUnavailableError();
      return text;
    },
  };
}

async function startServer(t, { ocr = fakeOcr() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-plan-server-'));
  const file = path.join(dir, 'plans.json');
  const store = new PlanStore(file);
  const server = createApp({ store, ocr, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { base, file, store, server };
}

async function requestJson(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await response.json();
  return { status: response.status, body };
}

test('手动录入计划：解析、编辑、勾选并持久化', async (t) => {
  const { base, file } = await startServer(t);

  const created = await requestJson(base, '/api/plans', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'manual',
      text: '今日待办\n- [ ] 回复客户邮件\n- [x] 整理会议纪要\n- [ ] 写周报',
    }),
  });

  assert.equal(created.status, 201);
  const plan = created.body.plan;
  assert.equal(plan.title, '今日待办');
  assert.deepEqual(plan.tasks.map((task) => [task.text, task.done]), [
    ['回复客户邮件', false],
    ['整理会议纪要', true],
    ['写周报', false],
  ]);

  const task = plan.tasks[0];
  const toggled = await requestJson(base, `/api/plans/${plan.id}/tasks/${task.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ done: true }),
  });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.body.plan.tasks[0].done, true);

  const edited = await requestJson(base, `/api/plans/${plan.id}/tasks/${task.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ text: '回复客户邮件并抄送经理' }),
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.plan.tasks[0].text, '回复客户邮件并抄送经理');

  const listed = await requestJson(base, '/api/plans');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.plans.length, 1);

  const reloaded = new PlanStore(file);
  const saved = reloaded.getPlan(plan.id);
  assert.equal(saved.tasks[0].done, true);
  assert.equal(saved.tasks[0].text, '回复客户邮件并抄送经理');
});

test('照片上传走本地 OCR，并保留原始顺序', async (t) => {
  const { base } = await startServer(t, {
    ocr: fakeOcr({ text: '本周计划\n- [ ] 采购打印纸\n- [ ] 准备复盘材料\n- [x] 预约牙医' }),
  });

  const created = await requestJson(base, '/api/plans', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'image',
      image: { filename: 'plan.png', data: `data:image/png;base64,${TINY_PNG}` },
    }),
  });

  assert.equal(created.status, 201);
  const plan = created.body.plan;
  assert.equal(plan.title, '本周计划');
  assert.equal(plan.source.type, 'image');
  assert.equal(plan.source.filename, 'plan.png');
  assert.deepEqual(plan.tasks.map((task) => task.text), ['采购打印纸', '准备复盘材料', '预约牙医']);
  assert.equal(plan.tasks[2].done, true);
});

test('没有本地 OCR 时返回 ocr_unavailable，供界面引导手动录入', async (t) => {
  const { base } = await startServer(t, { ocr: fakeOcr({ available: false }) });

  const created = await requestJson(base, '/api/plans', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'image',
      image: { filename: 'plan.png', data: `data:image/png;base64,${TINY_PNG}` },
    }),
  });

  assert.equal(created.status, 422);
  assert.equal(created.body.error.code, 'ocr_unavailable');
  assert.match(created.body.error.message, /手动录入/);
});

test('OCR 成功但没有文字时返回 no_tasks 和识别原文', async (t) => {
  const { base } = await startServer(t, { ocr: fakeOcr({ text: '   \n\n' }) });

  const created = await requestJson(base, '/api/plans', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'image',
      image: { filename: 'plan.jpg', data: `data:image/png;base64,${TINY_PNG}` },
    }),
  });

  assert.equal(created.status, 422);
  assert.equal(created.body.error.code, 'no_tasks');
  assert.equal(created.body.error.ocrText, '   \n\n');
});

test('任务增删和计划删除接口', async (t) => {
  const { base } = await startServer(t);
  const created = await requestJson(base, '/api/plans', {
    method: 'POST',
    body: JSON.stringify({ mode: 'manual', text: '- A' }),
  });
  const plan = created.body.plan;

  const added = await requestJson(base, `/api/plans/${plan.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ text: 'B' }),
  });
  assert.equal(added.status, 201);
  assert.deepEqual(added.body.plan.tasks.map((task) => task.text), ['A', 'B']);

  const taskId = added.body.plan.tasks[1].id;
  const removed = await requestJson(base, `/api/plans/${plan.id}/tasks/${taskId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.plan.tasks.map((task) => task.text), ['A']);

  const deleted = await requestJson(base, `/api/plans/${plan.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const listed = await requestJson(base, '/api/plans');
  assert.deepEqual(listed.body.plans, []);
});

test('非法请求有明确的错误响应', async (t) => {
  const { base } = await startServer(t);

  const empty = await requestJson(base, '/api/plans', {
    method: 'POST',
    body: JSON.stringify({ mode: 'manual', text: '   ' }),
  });
  assert.equal(empty.status, 422);
  assert.equal(empty.body.error.code, 'no_tasks');

  const nullBody = await requestJson(base, '/api/plans', { method: 'POST', body: 'null' });
  assert.equal(nullBody.status, 422);
  assert.equal(nullBody.body.error.code, 'invalid_request');

  const badImage = await requestJson(base, '/api/plans', {
    method: 'POST',
    body: JSON.stringify({ mode: 'image', image: { filename: 'x.txt', data: 'bm90IGFuIGltYWdl' } }),
  });
  assert.equal(badImage.status, 422);
  assert.equal(badImage.body.error.code, 'unsupported_image');

  const missing = await requestJson(base, '/api/plans/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'plan_not_found');
});

test('静态页面可访问，且不会越出 public 目录', async (t) => {
  const { base } = await startServer(t);

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /纸质计划/);

  const escaped = await fetch(`${base}/..%2fserver.js`);
  assert.equal(escaped.status, 403);
});

test('状态接口返回 OCR 可用信息', async (t) => {
  const { base } = await startServer(t);
  const status = await requestJson(base, '/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.ocr.available, true);
  assert.equal(status.body.ocr.lang, 'chi_sim+eng');
});
