const $ = (id) => document.getElementById(id);

const state = {
  plans: [],
  selectedId: null,
  ocrStatus: null,
  selectedFile: null,
  previewUrl: null,
  busy: false,
};

let pendingSaves = 0;
let toastTimer = null;

/* ---------- small helpers ---------- */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatShortDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function showToast(message, isError = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('is-error', isError);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, isError ? 6000 : 3000);
}

function setSaveState(mode, text) {
  const box = $('save-state');
  box.dataset.state = mode;
  $('save-text').textContent = text ?? (mode === 'saving' ? '保存中…' : mode === 'error' ? '保存失败' : '已保存');
}

function beginSave() {
  pendingSaves += 1;
  setSaveState('saving');
}

function endSave(failed = false) {
  pendingSaves = Math.max(0, pendingSaves - 1);
  if (failed) setSaveState('error');
  else if (pendingSaves === 0) setSaveState('saved');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // 非 JSON 响应留给下面的通用错误处理。
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`);
    error.code = payload?.error?.code;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function findPlan(planId) {
  return state.plans.find((plan) => plan.id === planId) ?? null;
}

function selectedPlan() {
  return state.selectedId ? findPlan(state.selectedId) : null;
}

function replacePlan(plan) {
  const index = state.plans.findIndex((item) => item.id === plan.id);
  if (index >= 0) state.plans[index] = plan;
  else state.plans.unshift(plan);
  state.plans.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  renderSidebar();
}

/* ---------- view switching ---------- */

function showWelcome() {
  $('welcome').hidden = false;
  $('new-plan-panel').hidden = true;
  $('plan-view').hidden = true;
}

function showPlanView() {
  $('welcome').hidden = true;
  $('new-plan-panel').hidden = true;
  $('plan-view').hidden = false;
}

function openNewPanel(tab = 'photo') {
  $('welcome').hidden = true;
  $('plan-view').hidden = true;
  $('new-plan-panel').hidden = false;
  switchTab(tab);
  $('new-plan-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (tab === 'manual') $('manual-text').focus();
  else $('recognize-btn').blur();
}

function closeNewPanel() {
  $('new-plan-panel').hidden = true;
  if (selectedPlan()) showPlanView();
  else showWelcome();
}

function switchTab(tab) {
  const photo = tab === 'photo';
  $('tab-photo').classList.toggle('is-active', photo);
  $('tab-manual').classList.toggle('is-active', !photo);
  $('tab-photo').setAttribute('aria-selected', String(photo));
  $('tab-manual').setAttribute('aria-selected', String(!photo));
  $('pane-photo').hidden = !photo;
  $('pane-manual').hidden = photo;
}

/* ---------- rendering ---------- */

function renderOcrHint() {
  const hint = $('ocr-hint');
  hint.hidden = false;
  if (state.ocrStatus?.available) {
    hint.classList.add('is-ok');
    hint.textContent = `本地 OCR 已就绪（Tesseract，语言：${state.ocrStatus.lang}）。照片只在本机处理。`;
  } else {
    hint.classList.remove('is-ok');
    hint.textContent = '未检测到本地 OCR。上传照片后可按提示手动录入文字；安装 Tesseract 的方法见 README。';
  }
}

function renderSidebar() {
  const list = $('plan-list');
  list.replaceChildren();
  $('sidebar-empty').hidden = state.plans.length > 0;

  for (const plan of state.plans) {
    const total = plan.tasks.length;
    const done = plan.tasks.filter((task) => task.done).length;
    const item = el('button', {
      class: `plan-item${plan.id === state.selectedId ? ' is-active' : ''}${total > 0 && done === total ? ' is-done' : ''}`,
      type: 'button',
      'data-plan-id': plan.id,
      'aria-current': plan.id === state.selectedId ? 'true' : 'false',
    }, [
      el('span', { class: 'plan-item-top' }, [
        el('span', { class: 'plan-item-title', text: plan.title }),
        el('span', { class: 'plan-item-count', text: `${done}/${total}` }),
      ]),
      el('span', { class: 'plan-item-meta', text: formatShortDate(plan.updatedAt) }),
    ]);
    item.addEventListener('click', () => selectPlan(plan.id));
    list.append(item);
  }
}

function renderPlan() {
  const plan = selectedPlan();
  if (!plan) {
    showWelcome();
    return;
  }
  showPlanView();
  $('plan-title').textContent = plan.title;

  const meta = $('plan-meta');
  meta.replaceChildren(
    el('span', {
      class: `source-badge${plan.source?.type === 'manual' ? ' is-manual' : ''}`,
      text: plan.source?.type === 'image' ? '照片识别' : '手动录入',
    }),
    el('span', { text: `创建于 ${formatDateTime(plan.createdAt)}` }),
  );

  $('delete-plan').dataset.planId = plan.id;
  renderTasks(plan);
  renderProgress(plan);
}

function renderTasks(plan) {
  const list = $('task-list');
  list.replaceChildren();
  $('no-tasks').hidden = plan.tasks.length > 0;

  for (const task of plan.tasks) {
    const checkbox = el('input', {
      class: 'task-check',
      type: 'checkbox',
      'aria-label': `完成任务：${task.text}`,
    });
    checkbox.checked = task.done;

    const text = el('input', {
      class: 'task-text',
      type: 'text',
      maxlength: '500',
      'aria-label': '任务内容',
      autocomplete: 'off',
    });
    text.value = task.text;

    const remove = el('button', {
      class: 'task-delete',
      type: 'button',
      title: '删除任务',
      'aria-label': `删除任务：${task.text}`,
      text: '×',
    });

    const row = el('li', { class: `task-row${task.done ? ' is-done' : ''}` }, [checkbox, text, remove]);

    checkbox.addEventListener('change', async () => {
      const next = checkbox.checked;
      task.done = next;
      row.classList.toggle('is-done', next);
      renderProgress(plan);
      await patchTask(plan.id, task.id, { done: next }, () => {
        task.done = !next;
        checkbox.checked = !next;
        row.classList.toggle('is-done', !next);
        renderProgress(plan);
      });
    });

    text.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        text.blur();
      }
    });

    text.addEventListener('change', async () => {
      const next = text.value.trim();
      if (!next) {
        text.value = task.text;
        showToast('任务内容不能为空', true);
        return;
      }
      if (next === task.text) {
        text.value = next;
        return;
      }
      const previous = task.text;
      task.text = next;
      await patchTask(plan.id, task.id, { text: next }, () => {
        task.text = previous;
        text.value = previous;
      });
    });

    remove.addEventListener('click', async () => {
      beginSave();
      try {
        const { plan: updated } = await api(`/api/plans/${plan.id}/tasks/${task.id}`, { method: 'DELETE' });
        replacePlan(updated);
        renderPlan();
      } catch (error) {
        showToast(error.message, true);
        endSave(true);
        return;
      }
      endSave();
    });

    list.append(row);
  }
}

function renderProgress(plan) {
  const total = plan.tasks.length;
  const done = plan.tasks.filter((task) => task.done).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  $('progress-fill').style.width = `${percent}%`;
  $('progress-bar').setAttribute('aria-valuenow', String(percent));
  $('progress-text').textContent = total === 0 ? '还没有任务' : `已完成 ${done} / ${total}`;
  const sidebarPlan = findPlan(plan.id);
  if (sidebarPlan) {
    const item = $('plan-list').querySelector(`[data-plan-id="${plan.id}"]`);
    if (item) {
      const count = item.querySelector('.plan-item-count');
      if (count) count.textContent = `${done}/${total}`;
      item.classList.toggle('is-done', total > 0 && done === total);
    }
  }
}

async function patchTask(planId, taskId, patch, revert) {
  beginSave();
  try {
    const { plan } = await api(`/api/plans/${planId}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    replacePlan(plan);
  } catch (error) {
    revert?.();
    showToast(error.message, true);
    endSave(true);
    return;
  }
  endSave();
}

/* ---------- data loading ---------- */

async function loadPlans(selectId = null) {
  const { plans } = await api('/api/plans');
  state.plans = plans;
  if (selectId && plans.some((plan) => plan.id === selectId)) {
    state.selectedId = selectId;
  } else if (!plans.some((plan) => plan.id === state.selectedId)) {
    state.selectedId = plans[0]?.id ?? null;
  }
  renderSidebar();
  if (state.selectedId) {
    renderPlan();
  } else {
    showWelcome();
  }
}

function selectPlan(planId) {
  state.selectedId = planId;
  renderSidebar();
  renderPlan();
}

/* ---------- new plan: photo ---------- */

function setSelectedFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('请选择图片文件', true);
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    showToast('图片不能超过 15 MB', true);
    return;
  }
  state.selectedFile = file;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  $('file-thumb').src = state.previewUrl;
  $('file-name').textContent = file.name;
  $('file-size').textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  $('file-preview').hidden = false;
  $('dropzone').hidden = true;
  $('recognize-btn').disabled = false;
  $('photo-fallback').hidden = true;
}

function clearFile() {
  state.selectedFile = null;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  $('photo-input').value = '';
  $('file-preview').hidden = true;
  $('dropzone').hidden = false;
  $('recognize-btn').disabled = true;
  $('photo-fallback').hidden = true;
}

function setBusy(button, busy, busyText) {
  state.busy = busy;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    if (button.dataset.label) button.textContent = button.dataset.label;
    button.disabled = false;
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function showFallback(message, text = '') {
  $('fallback-message').textContent = message;
  if (text) $('fallback-text').value = text;
  $('photo-fallback').hidden = false;
  $('photo-fallback').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('fallback-text').focus();
}

async function recognizePhoto() {
  if (!state.selectedFile || state.busy) return;
  const button = $('recognize-btn');
  setBusy(button, true, '正在识别…');
  try {
    const data = await fileToDataUrl(state.selectedFile);
    const { plan } = await api('/api/plans', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'image',
        image: { filename: state.selectedFile.name, data },
      }),
    });
    clearFile();
    closeNewPanel();
    await loadPlans(plan.id);
    showToast('已生成任务清单');
  } catch (error) {
    if (error.code === 'ocr_unavailable') {
      showFallback(error.message);
    } else if (error.code === 'no_tasks') {
      showFallback(
        error.payload?.error?.message ?? '没有从图片中识别出任务，可以手动修正文字。',
        error.payload?.error?.ocrText ?? '',
      );
    } else {
      showToast(error.message, true);
    }
  } finally {
    setBusy(button, false);
    button.disabled = !state.selectedFile;
  }
}

/* ---------- new plan: manual ---------- */

async function submitManual(text, { button, sourceLabel } = {}) {
  if (state.busy) return;
  if (!text.trim()) {
    showToast('请先输入计划文字', true);
    return;
  }
  if (button) setBusy(button, true, '正在生成…');
  try {
    const { plan } = await api('/api/plans', {
      method: 'POST',
      body: JSON.stringify({ mode: 'manual', text }),
    });
    $('manual-text').value = '';
    $('fallback-text').value = '';
    clearFile();
    closeNewPanel();
    await loadPlans(plan.id);
    showToast(sourceLabel ?? '已生成任务清单');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    if (button) setBusy(button, false);
  }
}

/* ---------- events ---------- */

function bindEvents() {
  $('new-plan-btn').addEventListener('click', () => openNewPanel('photo'));
  $('welcome-photo').addEventListener('click', () => openNewPanel('photo'));
  $('welcome-manual').addEventListener('click', () => openNewPanel('manual'));
  $('close-new-panel').addEventListener('click', closeNewPanel);

  $('tab-photo').addEventListener('click', () => switchTab('photo'));
  $('tab-manual').addEventListener('click', () => switchTab('manual'));

  $('photo-input').addEventListener('change', (event) => {
    setSelectedFile(event.target.files?.[0]);
  });
  $('clear-file').addEventListener('click', clearFile);
  $('recognize-btn').addEventListener('click', recognizePhoto);

  const dropzone = $('dropzone');
  for (const eventName of ['dragenter', 'dragover']) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-dragging');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-dragging');
    });
  }
  dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) setSelectedFile(file);
  });

  $('fallback-submit').addEventListener('click', () => {
    submitManual($('fallback-text').value, { button: $('fallback-submit'), sourceLabel: '已按手动文字生成任务' });
  });

  $('manual-submit').addEventListener('click', () => {
    submitManual($('manual-text').value, { button: $('manual-submit') });
  });

  $('manual-text').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      $('manual-submit').click();
    }
  });

  $('delete-plan').addEventListener('click', async () => {
    const plan = selectedPlan();
    if (!plan) return;
    if (!window.confirm(`删除计划“${plan.title}”及其全部任务？`)) return;
    beginSave();
    try {
      await api(`/api/plans/${plan.id}`, { method: 'DELETE' });
      state.selectedId = null;
      await loadPlans();
      showToast('计划已删除');
    } catch (error) {
      showToast(error.message, true);
      endSave(true);
      return;
    }
    endSave();
  });

  $('add-task-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const plan = selectedPlan();
    const input = $('add-task-input');
    const text = input.value.trim();
    if (!plan || !text) return;
    beginSave();
    try {
      const { plan: updated } = await api(`/api/plans/${plan.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      replacePlan(updated);
      renderPlan();
      input.value = '';
      input.focus();
    } catch (error) {
      showToast(error.message, true);
      endSave(true);
      return;
    }
    endSave();
  });
}

/* ---------- boot ---------- */

async function init() {
  bindEvents();
  try {
    const [status, plans] = await Promise.all([api('/api/status'), api('/api/plans')]);
    state.ocrStatus = status.ocr;
    renderOcrHint();
    state.plans = plans.plans;
    state.selectedId = state.plans[0]?.id ?? null;
    renderSidebar();
    if (state.selectedId) renderPlan();
    else showWelcome();
  } catch (error) {
    showToast(`无法连接本地服务：${error.message}`, true);
    showWelcome();
  }
}

init();
