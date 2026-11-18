import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class StoreError extends Error {
  constructor(message, code = 'store_error', status = 400) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
  }
}

const DATA_VERSION = 1;

function newId() {
  return crypto.randomUUID();
}

// 单调递增的时间戳：同一毫秒内连续修改也能得到稳定排序。
let lastTimestamp = 0;
function nowIso() {
  const now = Date.now();
  lastTimestamp = now > lastTimestamp ? now : lastTimestamp + 1;
  return new Date(lastTimestamp).toISOString();
}

function clone(value) {
  return structuredClone(value);
}

function validateTask(task, planId) {
  if (!task || typeof task !== 'object') {
    throw new StoreError(`计划 ${planId} 中存在无效任务`, 'invalid_data', 500);
  }
  if (typeof task.text !== 'string' || task.text.trim() === '') {
    throw new StoreError(`计划 ${planId} 中存在空任务`, 'invalid_data', 500);
  }
  if (typeof task.done !== 'boolean') {
    throw new StoreError(`计划 ${planId} 中的任务缺少完成状态`, 'invalid_data', 500);
  }
}

function validateData(data) {
  if (!data || typeof data !== 'object' || data.version !== DATA_VERSION || !Array.isArray(data.plans)) {
    throw new StoreError('数据文件格式不正确，已停止读写以免覆盖原数据', 'invalid_data', 500);
  }
  for (const plan of data.plans) {
    if (!plan || typeof plan.id !== 'string' || typeof plan.title !== 'string' || !Array.isArray(plan.tasks)) {
      throw new StoreError('数据文件中存在无效计划，已停止读写以免覆盖原数据', 'invalid_data', 500);
    }
    for (const task of plan.tasks) validateTask(task, plan.id);
  }
}

/**
 * 单文件 JSON 持久化。每次修改都先写临时文件再原子替换，
 * 避免进程中断时留下半截 JSON。
 */
export class PlanStore {
  constructor(filePath) {
    if (!filePath) throw new StoreError('缺少数据文件路径', 'invalid_config', 500);
    this.filePath = path.resolve(filePath);
    this.data = this.#load();
  }

  #load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { version: DATA_VERSION, plans: [] };
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StoreError(
        `数据文件 ${this.filePath} 不是合法 JSON，已停止读写以免覆盖原数据`,
        'invalid_data',
        500,
      );
    }
    validateData(parsed);
    return parsed;
  }

  #write(data) {
    validateData(data);
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
    );
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 临时文件可能尚未创建，忽略清理失败。
      }
      throw error;
    }
  }

  #mutate(mutator) {
    const draft = clone(this.data);
    const result = mutator(draft);
    this.#write(draft);
    this.data = draft;
    return clone(result);
  }

  #findPlan(data, planId) {
    const plan = data.plans.find((item) => item.id === planId);
    if (!plan) throw new StoreError('计划不存在或已被删除', 'plan_not_found', 404);
    return plan;
  }

  listPlans() {
    return clone(
      [...this.data.plans].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    );
  }

  getPlan(planId) {
    return clone(this.#findPlan(this.data, planId));
  }

  createPlan({ title, source = { type: 'manual' }, tasks }) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new StoreError('计划至少需要一条任务', 'no_tasks', 422);
    }
    const timestamp = nowIso();
    const plan = {
      id: newId(),
      title: typeof title === 'string' && title.trim() ? title.trim() : '未命名计划',
      source: {
        type: source.type === 'image' ? 'image' : 'manual',
        ...(source.filename ? { filename: String(source.filename) } : {}),
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      tasks: tasks.map((task) => ({
        id: newId(),
        text: String(task.text).trim(),
        done: Boolean(task.done),
      })),
    };
    for (const task of plan.tasks) {
      if (!task.text) throw new StoreError('任务内容不能为空', 'invalid_task', 422);
    }
    return this.#mutate((data) => {
      data.plans.push(plan);
      return plan;
    });
  }

  updateTask(planId, taskId, patch) {
    const hasText = Object.hasOwn(patch ?? {}, 'text');
    const hasDone = Object.hasOwn(patch ?? {}, 'done');
    if (!hasText && !hasDone) {
      throw new StoreError('没有可更新的字段', 'invalid_patch', 422);
    }
    if (hasText && (typeof patch.text !== 'string' || patch.text.trim() === '')) {
      throw new StoreError('任务内容不能为空', 'invalid_task', 422);
    }
    if (hasDone && typeof patch.done !== 'boolean') {
      throw new StoreError('完成状态必须是布尔值', 'invalid_task', 422);
    }

    return this.#mutate((data) => {
      const plan = this.#findPlan(data, planId);
      const task = plan.tasks.find((item) => item.id === taskId);
      if (!task) throw new StoreError('任务不存在或已被删除', 'task_not_found', 404);
      if (hasText) task.text = patch.text.trim();
      if (hasDone) task.done = patch.done;
      plan.updatedAt = nowIso();
      return plan;
    });
  }

  addTask(planId, text, done = false) {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new StoreError('任务内容不能为空', 'invalid_task', 422);
    }
    return this.#mutate((data) => {
      const plan = this.#findPlan(data, planId);
      plan.tasks.push({ id: newId(), text: text.trim(), done: Boolean(done) });
      plan.updatedAt = nowIso();
      return plan;
    });
  }

  removeTask(planId, taskId) {
    return this.#mutate((data) => {
      const plan = this.#findPlan(data, planId);
      const index = plan.tasks.findIndex((item) => item.id === taskId);
      if (index === -1) throw new StoreError('任务不存在或已被删除', 'task_not_found', 404);
      plan.tasks.splice(index, 1);
      plan.updatedAt = nowIso();
      return plan;
    });
  }

  removePlan(planId) {
    return this.#mutate((data) => {
      const index = data.plans.findIndex((item) => item.id === planId);
      if (index === -1) throw new StoreError('计划不存在或已被删除', 'plan_not_found', 404);
      const [removed] = data.plans.splice(index, 1);
      return removed;
    });
  }
}
