import test from 'node:test';
import assert from 'node:assert/strict';

import { OcrUnavailableError, TesseractOcr } from '../lib/ocr.js';

test('找不到 Tesseract 时状态为不可用，并给出原因', async () => {
  const ocr = new TesseractOcr({ binary: '/definitely/not-a-real/tesseract' });
  const status = await ocr.status();
  assert.equal(status.available, false);
  assert.equal(status.lang, null);
  assert.match(status.reason, /未找到/);
});

test('不可用时调用 recognize 抛出 ocr_unavailable，而不是崩溃', async () => {
  const ocr = new TesseractOcr({ binary: '/definitely/not-a-real/tesseract' });
  await assert.rejects(
    () => ocr.recognize('/tmp/whatever.png'),
    (error) => error instanceof OcrUnavailableError && error.code === 'ocr_unavailable',
  );
});
