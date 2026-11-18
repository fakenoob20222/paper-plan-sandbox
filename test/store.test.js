import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PlanStore } from '../lib/store.js';

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-plan-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'data', 'plans.json');
  return { dir, file, store: new PlanStore(file) };
}

test('新数据文件不存在时从空列表开始', (t) => {
  const { store, file } = tempStore(t);
  assert.deepEqual(store.listPlans(), []);
  assert.equal(fs.existsSync(file), false);
});

test('创建计划并按最近更新排序', (t) => {
  const { store } = tempStore(t);
  const first = store.createPlan({
    title: '第一份',
    source: { type: 'manual' },
    tasks: [{ text: 'A' }, { text: 'B', done: true }],
  });
  const second = store.createPlan({
    title: '第二份',
    source: { type: 'image', filename: 'plan.png' },
    tasks: [{ text: 'C' }],
  });

  assert.equal(first.tasks.length, 2);
  assert.equal(first.tasks[0].text, 'A');
  assert.equal(first.tasks[1].done, true);
  assert.equal(second.source.filename, 'plan.png');

  const plans = store.listPlans();
  assert.equal(plans.length, 2);
  assert.equal(plans[0].id, second.id);
});

test('修改任务文字和完成状态后会写回磁盘', (t) => {
  const { store, file } = tempStore(t);
  const plan = store.createPlan({ title: '测试', tasks: [{ text: '写周报' }] });
  const taskId = plan.tasks[0].id;

  store.updateTask(plan.id, taskId, { text: '写周报并发给团队' });
  store.updateTask(plan.id, taskId, { done: true });

  const reloaded = new PlanStore(file);
  const saved = reloaded.getPlan(plan.id);
  assert.equal(saved.tasks[0].text, '写周报并发给团队');
  assert.equal(saved.tasks[0].done, true);
  assert.ok(saved.updatedAt >= saved.createdAt);
});

test('添加、删除任务和删除计划都会持久化', (t) => {
  const { store, file } = tempStore(t);
  const plan = store.createPlan({ title: '测试', tasks: [{ text: 'A' }] });

  const withAdded = store.addTask(plan.id, 'B');
  assert.deepEqual(withAdded.tasks.map((task) => task.text), ['A', 'B']);

  const addedTask = withAdded.tasks.find((task) => task.text === 'B');
  const withRemoved = store.removeTask(plan.id, addedTask.id);
  assert.deepEqual(withRemoved.tasks.map((task) => task.text), ['A']);

  store.removePlan(plan.id);
  assert.deepEqual(store.listPlans(), []);
  assert.deepEqual(new PlanStore(file).listPlans(), []);
});

test('返回的对象是副本，外部修改不会污染已保存数据', (t) => {
  const { store } = tempStore(t);
  const plan = store.createPlan({ title: '测试', tasks: [{ text: 'A' }] });
  plan.tasks[0].text = '被外部改掉';
  assert.equal(store.getPlan(plan.id).tasks[0].text, 'A');
});

test('写入完成后不残留临时文件', (t) => {
  const { store, file } = tempStore(t);
  store.createPlan({ title: '测试', tasks: [{ text: 'A' }] });
  const dir = path.dirname(file);
  assert.deepEqual(fs.readdirSync(dir), ['plans.json']);
});

test('损坏的 JSON 会明确报错，而不是静默覆盖', (t) => {
  const { file } = tempStore(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json', 'utf8');
  assert.throws(() => new PlanStore(file), /不是合法 JSON/);
});

test('缺少必要字段的数据文件会被拒绝', (t) => {
  const { file } = tempStore(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, plans: [{ id: 'x' }] }), 'utf8');
  assert.throws(() => new PlanStore(file), /无效计划/);
});

test('非法更新会返回可识别的错误码', (t) => {
  const { store } = tempStore(t);
  const plan = store.createPlan({ title: '测试', tasks: [{ text: 'A' }] });

  assert.throws(
    () => store.updateTask(plan.id, plan.tasks[0].id, { done: 'yes' }),
    (error) => error.code === 'invalid_task' && error.status === 422,
  );
  assert.throws(
    () => store.updateTask(plan.id, 'missing', { done: true }),
    (error) => error.code === 'task_not_found' && error.status === 404,
  );
  assert.throws(
    () => store.createPlan({ title: '空', tasks: [] }),
    (error) => error.code === 'no_tasks',
  );
});
