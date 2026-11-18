import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parsePlan } from './lib/parser.js';
import { PlanStore } from './lib/store.js';
import { TesseractOcr } from './lib/ocr.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, error, logger) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' ? error.code : 'internal_error';
  if (status >= 500) logger.error?.(error);
  sendJson(res, status, { error: { code, message: error?.message || '服务器内部错误' } });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'payload_too_large', '请求内容过大（上限 24 MB）');
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new HttpError(400, 'empty_body', '请求内容为空');
  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.includes('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', '请使用 application/json 提交');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', '请求内容不是合法 JSON');
  }
}

function decodeImagePayload(image) {
  if (!image || typeof image !== 'object') {
    throw new HttpError(422, 'invalid_image', '缺少图片数据');
  }
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/isu.exec(String(image.data ?? ''));
  const base64 = match ? match[2] : String(image.data ?? '');
  if (!base64.trim()) throw new HttpError(422, 'invalid_image', '缺少图片数据');

  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    throw new HttpError(422, 'invalid_image', '图片内容不是合法 base64');
  }
  if (buffer.length === 0) throw new HttpError(422, 'invalid_image', '图片内容为空');
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new HttpError(413, 'image_too_large', '图片过大（上限 15 MB）');
  }

  const extension = detectImageExtension(buffer);
  if (!extension) {
    throw new HttpError(422, 'unsupported_image', '暂不支持这种图片格式，请使用 PNG、JPEG、WebP、BMP、TIFF 或 GIF');
  }
  const filename = typeof image.filename === 'string' && image.filename.trim()
    ? path.basename(image.filename.trim())
    : `plan.${extension.slice(1)}`;
  return { buffer, extension, filename };
}

function detectImageExtension(buffer) {
  if (buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.length >= 6 && buffer.subarray(0, 4).toString('ascii') === 'GIF8') return '.gif';
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString('ascii') === 'BM') return '.bmp';
  if (buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  if (buffer.length >= 4) {
    const head = buffer.subarray(0, 4);
    if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0x00) ||
        (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && head[3] === 0x2a)) return '.tiff';
  }
  return null;
}

function defaultTitle(source) {
  if (source.type === 'image' && source.filename) {
    const base = source.filename.replace(/\.[^.]+$/u, '').trim();
    if (base) return base.slice(0, 80);
  }
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `手动计划 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

async function createPlanFromText(store, text, source) {
  const parsed = parsePlan(text);
  if (parsed.tasks.length === 0) {
    throw new HttpError(422, 'no_tasks', '没有解析出任何任务，请检查文字内容');
  }
  const plan = store.createPlan({
    title: parsed.title || defaultTitle(source),
    source,
    tasks: parsed.tasks,
  });
  return { plan, parsed };
}

async function recognizeImage(ocr, image) {
  const status = await ocr.status();
  if (!status.available) {
    const error = new Error(
      `${status.reason ?? '本机没有可用的本地 OCR'}。请在下方文本框中手动录入或粘贴图片里的文字。`,
    );
    error.code = 'ocr_unavailable';
    error.status = 422;
    throw error;
  }
  const tempPath = path.join(os.tmpdir(), `paper-plan-ocr-${crypto.randomUUID()}${image.extension}`);
  await fsp.writeFile(tempPath, image.buffer);
  try {
    return await ocr.recognize(tempPath);
  } finally {
    await fsp.unlink(tempPath).catch(() => {});
  }
}

async function handleApi(req, res, store, ocr, logger) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/status' && req.method === 'GET') {
    const ocrStatus = await ocr.status();
    sendJson(res, 200, { ocr: ocrStatus });
    return true;
  }

  if (pathname === '/api/plans' && req.method === 'GET') {
    sendJson(res, 200, { plans: store.listPlans() });
    return true;
  }

  if (pathname === '/api/plans' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object') {
      throw new HttpError(422, 'invalid_request', '请求内容必须是 JSON 对象');
    }
    if (body.mode === 'image') {
      const image = decodeImagePayload(body.image);
      let text;
      try {
        text = await recognizeImage(ocr, image);
      } catch (error) {
        if (error.code === 'ocr_unavailable') {
          sendJson(res, 422, {
            error: {
              code: 'ocr_unavailable',
              message: `${error.message}`,
            },
          });
          return true;
        }
        throw error;
      }
      const parsed = parsePlan(text);
      if (parsed.tasks.length === 0) {
        sendJson(res, 422, {
          error: {
            code: 'no_tasks',
            message: '图片里没有识别出可用的任务，可以复制识别文字后手动修正，或直接手动录入。',
            ocrText: text,
          },
        });
        return true;
      }
      const plan = store.createPlan({
        title: parsed.title || defaultTitle({ type: 'image', filename: image.filename }),
        source: { type: 'image', filename: image.filename },
        tasks: parsed.tasks,
      });
      sendJson(res, 201, { plan, ocrText: text });
      return true;
    }

    if (body.mode === 'manual' || typeof body.text === 'string') {
      const text = String(body.text ?? '').slice(0, 50_000);
      const { plan } = await createPlanFromText(store, text, { type: 'manual' });
      sendJson(res, 201, { plan });
      return true;
    }

    throw new HttpError(422, 'invalid_request', '请提供 mode 为 image 或 manual 的请求内容');
  }

  const planMatch = /^\/api\/plans\/([^/]+)$/u.exec(pathname);
  if (planMatch) {
    const planId = decodeURIComponent(planMatch[1]);
    if (req.method === 'GET') {
      sendJson(res, 200, { plan: store.getPlan(planId) });
      return true;
    }
    if (req.method === 'DELETE') {
      const removed = store.removePlan(planId);
      sendJson(res, 200, { removed });
      return true;
    }
    throw new HttpError(405, 'method_not_allowed', '不支持的请求方法');
  }

  const taskMatch = /^\/api\/plans\/([^/]+)\/tasks(?:\/([^/]+))?$/u.exec(pathname);
  if (taskMatch) {
    const planId = decodeURIComponent(taskMatch[1]);
    const taskId = taskMatch[2] ? decodeURIComponent(taskMatch[2]) : null;

    if (!taskId && req.method === 'POST') {
      const body = await readBody(req);
      const plan = store.addTask(planId, String(body.text ?? ''), Boolean(body.done));
      sendJson(res, 201, { plan });
      return true;
    }

    if (taskId && req.method === 'PATCH') {
      const body = await readBody(req);
      const plan = store.updateTask(planId, taskId, body);
      sendJson(res, 200, { plan });
      return true;
    }

    if (taskId && req.method === 'DELETE') {
      const plan = store.removeTask(planId, taskId);
      sendJson(res, 200, { plan });
      return true;
    }

    throw new HttpError(405, 'method_not_allowed', '不支持的请求方法');
  }

  throw new HttpError(404, 'not_found', '接口不存在');
}

async function serveStatic(req, res, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'method_not_allowed', '不支持的请求方法');
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  let relative;
  try {
    relative = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'invalid_path', '路径格式不正确');
  }
  if (relative === '/') relative = '/index.html';
  const resolved = path.resolve(publicDir, `.${relative}`);
  if (resolved !== publicDir && !resolved.startsWith(`${publicDir}${path.sep}`)) {
    throw new HttpError(403, 'forbidden', '禁止访问该路径');
  }

  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    throw new HttpError(404, 'not_found', '文件不存在');
  }
  if (!stat.isFile()) throw new HttpError(404, 'not_found', '文件不存在');

  const type = MIME_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(resolved);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * 可注入 store / ocr，便于离线测试。
 */
export function createApp({ store, ocr, publicDir = path.join(ROOT, 'public'), logger = console } = {}) {
  if (!store) throw new Error('createApp 需要 store');
  if (!ocr) throw new Error('createApp 需要 ocr');
  const publicRoot = path.resolve(publicDir);

  return http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        await handleApi(req, res, store, ocr, logger);
      } else {
        await serveStatic(req, res, publicRoot);
      }
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, error, logger);
    }
  });
}

async function main() {
  const dataFile = process.env.PLAN_DATA_FILE || path.join(ROOT, 'data', 'plans.json');
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';

  let store;
  try {
    store = new PlanStore(dataFile);
  } catch (error) {
    console.error(`无法读取数据文件：${error.message}`);
    process.exit(1);
  }

  const ocr = new TesseractOcr();
  const server = createApp({ store, ocr });
  server.listen(port, host, () => {
    console.log(`纸质计划 → 任务清单 已启动：http://${host}:${port}`);
    console.log(`数据文件：${dataFile}`);
    ocr.status().then((status) => {
      if (status.available) {
        console.log(`本地 OCR 就绪：${status.version}（语言：${status.lang}）`);
      } else {
        console.log(`本地 OCR 不可用：${status.reason}`);
        console.log('可改用手动录入，或按 README 安装 Tesseract 后重启。');
      }
    });
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
