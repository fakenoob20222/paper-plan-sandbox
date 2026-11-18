import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class OcrUnavailableError extends Error {
  constructor(message = '本机没有可用的本地 OCR') {
    super(message);
    this.name = 'OcrUnavailableError';
    this.code = 'ocr_unavailable';
    this.status = 422;
  }
}

export class OcrFailedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OcrFailedError';
    this.code = 'ocr_failed';
    this.status = 502;
  }
}

function pickLanguage(available, requested) {
  if (requested) return requested;
  const has = (name) => available.includes(name);
  if (has('chi_sim') && has('eng')) return 'chi_sim+eng';
  if (has('chi_sim')) return 'chi_sim';
  if (has('eng')) return 'eng';
  return available.find((name) => name !== 'osd') ?? null;
}

/**
 * 调用本机安装的 Tesseract 命令行做 OCR。
 * 不联网、不需要 API key；Tesseract 不存在时返回 available:false，
 * 由界面引导用户改用手动录入。
 */
export class TesseractOcr {
  constructor({ binary = process.env.PLAN_OCR_BIN || 'tesseract', lang = process.env.PLAN_OCR_LANG || null, timeoutMs = 60_000 } = {}) {
    this.binary = binary;
    this.requestedLang = lang;
    this.timeoutMs = timeoutMs;
    this.detection = null;
  }

  async #detect() {
    if (this.detection) return this.detection;
    this.detection = (async () => {
      try {
        const versionResult = await execFileAsync(this.binary, ['--version'], { timeout: 10_000 });
        const version = String(versionResult.stdout).split('\n')[0].trim();
        const langResult = await execFileAsync(this.binary, ['--list-langs'], { timeout: 10_000 });
        const languages = String(langResult.stdout)
          .split(/\r?\n/gu)
          .map((line) => line.trim())
          .filter((line) => line && !/^List of available/iu.test(line) && line !== 'osd');
        const lang = pickLanguage(languages, this.requestedLang);
        if (!lang) {
          return { available: false, version, languages, lang: null, reason: '未安装任何 Tesseract 语言包' };
        }
        return { available: true, version, languages, lang };
      } catch (error) {
        return {
          available: false,
          version: null,
          languages: [],
          lang: null,
          reason: error.code === 'ENOENT'
            ? `未找到 ${this.binary} 可执行文件`
            : `无法运行本地 OCR：${error.message}`,
        };
      }
    })();
    return this.detection;
  }

  async status() {
    return { ...(await this.#detect()) };
  }

  async recognize(imagePath) {
    const status = await this.#detect();
    if (!status.available) {
      throw new OcrUnavailableError(status.reason ?? '本机没有可用的本地 OCR');
    }
    const args = [imagePath, 'stdout', '--psm', '6', '-l', status.lang];
    try {
      const { stdout } = await execFileAsync(this.binary, args, {
        timeout: this.timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
      });
      return String(stdout).trim();
    } catch (error) {
      const detail = String(error.stderr ?? '').trim() || error.message;
      throw new OcrFailedError(`本地 OCR 识别失败：${detail}`);
    }
  }
}
