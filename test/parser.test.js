import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePlan, parseTasks } from '../lib/parser.js';

test('按原始顺序拆分任务并去掉列表符号', () => {
  const tasks = parseTasks(`
    - 写周报
    * 整理会议纪要
    1. 回复客户邮件
    2) 预约牙医
    (3) 购买打印纸
  `);

  assert.deepEqual(tasks.map((task) => task.text), [
    '写周报',
    '整理会议纪要',
    '回复客户邮件',
    '预约牙医',
    '购买打印纸',
  ]);
  assert.ok(tasks.every((task) => task.done === false));
});

test('识别多种复选框标记，并把勾选状态带入任务', () => {
  const tasks = parseTasks(`
    [ ] 未完成 A
    [x] 已完成 B
    [X] 已完成 C
    ☐ 未完成 D
    ☑ 已完成 E
    - [ ] 未完成 F
    - [x] 已完成 G
    喝茶 ☑
  `);

  assert.deepEqual(
    tasks.map((task) => [task.text, task.done]),
    [
      ['未完成 A', false],
      ['已完成 B', true],
      ['已完成 C', true],
      ['未完成 D', false],
      ['已完成 E', true],
      ['未完成 F', false],
      ['已完成 G', true],
      ['喝茶', true],
    ],
  );
});

test('兼容 OCR 识别出的残缺复选框', () => {
  const tasks = parseTasks(`
    [] 整理周报
    [] 采购打印纸
    x] 预约牙医
    [ 阅读第三章
  `);
  assert.deepEqual(
    tasks.map((task) => [task.text, task.done]),
    [
      ['整理周报', false],
      ['采购打印纸', false],
      ['预约牙医', true],
      ['阅读第三章', false],
    ],
  );
});

test('保留时间开头的任务，不把 9:00 误当编号', () => {
  const tasks = parseTasks('9:00 站会\n10:30 和设计师过稿');
  assert.deepEqual(tasks.map((task) => task.text), ['9:00 站会', '10:30 和设计师过稿']);
});

test('处理 CRLF、BOM、空行和多余空白', () => {
  const tasks = parseTasks('\uFEFF第一行\r\n\r\n   第二行   \r第三行\t');
  assert.deepEqual(tasks.map((task) => task.text), ['第一行', '第二行', '第三行']);
});

test('开头的标题行不会被当成任务', () => {
  const parsed = parsePlan(`
    本周计划
    2026-11-16 周一
    - [ ] 写周报
    - [ ] 整理会议纪要
  `);

  assert.equal(parsed.title, '本周计划 · 2026-11-16 周一');
  assert.deepEqual(parsed.tasks.map((task) => task.text), ['写周报', '整理会议纪要']);
});

test('标题中的 OCR 日期标点会被规范化', () => {
  const parsed = parsePlan('本周计划\n11月16日.周一\n- 写周报');
  assert.equal(parsed.title, '本周计划 · 11月16日 周一');
});

test('只有标题样式的一行时仍然保留为任务', () => {
  assert.deepEqual(parsePlan('购物清单'), {
    title: null,
    tasks: [{ text: '购物清单', done: false }],
  });
});

test('不把像任务的“完成旅行计划”误判为标题', () => {
  const parsed = parsePlan('- 完成旅行计划\n- 订机票');
  assert.equal(parsed.title, null);
  assert.deepEqual(parsed.tasks.map((task) => task.text), ['完成旅行计划', '订机票']);
});

test('空输入返回空计划', () => {
  assert.deepEqual(parsePlan(''), { title: null, tasks: [] });
  assert.deepEqual(parsePlan('   \n\n'), { title: null, tasks: [] });
});

test('重复任务原样保留，不做去重', () => {
  const tasks = parseTasks('- 喝水\n- 喝水');
  assert.deepEqual(tasks.map((task) => task.text), ['喝水', '喝水']);
});
