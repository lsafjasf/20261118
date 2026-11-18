import { chromium, expect, test } from '@playwright/test';

const URL = 'http://127.0.0.1:5199/';

test.describe.configure({ mode: 'serial' });

test('绿幕工具：三画布渲染、参数联动、歧义提示与 WebCodecs 导出解码', async () => {
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader']
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await expect(page.locator('h1')).toContainText('绿幕抠像工作台');

  // 三块画布都有非空像素
  for (const id of ['cvOriginal', 'cvMatte', 'cvComposite']) {
    const nonEmpty = await page.evaluate((canvasId) => {
      const cv = document.getElementById(canvasId) as HTMLCanvasElement;
      const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4096) sum += d[i] + d[i + 1] + d[i + 2];
      return sum;
    }, id);
    expect(nonEmpty).toBeGreaterThan(0);
  }

  // 歧义提示出现（绿色徽章）
  await expect(page.locator('#warnBox.show')).toBeVisible();

  // 指标渲染完整
  await expect(page.locator('.metric')).toHaveCount(8);

  // 拖动容差滑块，指标发生变化
  const edgeBefore = await page.locator('.metric').nth(3).locator('b').textContent();
  await page.locator('#tolerance').fill('55');
  await page.waitForTimeout(150);
  const edgeAfter = await page.locator('.metric').nth(3).locator('b').textContent();
  expect(edgeAfter).not.toBe(edgeBefore);
  await page.locator('#tolerance').fill('22');
  await page.waitForTimeout(150);

  // 帧切换可用
  await page.locator('#frameSlider').fill('11');
  await expect(page.locator('#frameLabel')).toContainText('12 / 24');

  // 保护模式切换按钮高亮
  await page.locator('#protectBtn').click();
  await expect(page.locator('#protectBtn')).toHaveClass(/active/);

  // 在徽章区域（蓝色主体右上的绿色圆）涂抹保护，验证 alpha 被恢复为 255
  const badge = await page.evaluate(() => {
    const matte = document.getElementById('cvMatte') as HTMLCanvasElement;
    const d = matte.getContext('2d')!.getImageData(0, 0, matte.width, matte.height).data;
    const mask = new Uint8Array(matte.width * matte.height);
    for (let y = 0; y < matte.height; y++) {
      for (let x = 0; x < matte.width; x++) {
        const o = (y * matte.width + x) * 4;
        if (d[o] === 245 && d[o + 1] === 165 && d[o + 2] === 36) {
          mask[y * matte.width + x] = 1;
        }
      }
    }
    // 4-连通域，取最大块的质心（绿色徽章），排除纱上的零散碎点
    const seen = new Uint8Array(mask.length);
    let best: Array<[number, number]> = [];
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || seen[start]) continue;
      const stack = [start];
      const comp: Array<[number, number]> = [];
      seen[start] = 1;
      while (stack.length) {
        const idx = stack.pop()!;
        comp.push([idx % matte.width, Math.floor(idx / matte.width)]);
        for (const nb of [idx - 1, idx + 1, idx - matte.width, idx + matte.width]) {
          if (nb >= 0 && nb < mask.length && mask[nb] && !seen[nb]) {
            seen[nb] = 1;
            stack.push(nb);
          }
        }
      }
      if (comp.length > best.length) best = comp;
    }
    const cx = Math.round(best.reduce((s, p) => s + p[0], 0) / best.length);
    const cy = Math.round(best.reduce((s, p) => s + p[1], 0) / best.length);
    return { x: cx, y: cy, count: best.length };
  });
  expect(badge.count).toBeGreaterThan(200);

  const cvBox = await page.locator('#cvOriginal').boundingBox();
  expect(cvBox).not.toBeNull();
  const toClientX = (x: number): number => cvBox!.x + (x / 480) * cvBox!.width;
  const toClientY = (y: number): number => cvBox!.y + (y / 270) * cvBox!.height;
  await page.mouse.move(toClientX(badge.x - 10), toClientY(badge.y));
  await page.mouse.down();
  for (let dx = -10; dx <= 10; dx += 2) {
    await page.mouse.move(toClientX(badge.x + dx), toClientY(badge.y));
  }
  await page.mouse.up();
  await page.waitForTimeout(250);

  const restored = await page.evaluate((center) => {
    const matte = document.getElementById('cvMatte') as HTMLCanvasElement;
    const d = matte.getContext('2d')!.getImageData(center.x, center.y, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, badge);
  expect(restored).toEqual([180, 210, 255]);
  await page.locator('#protectBtn').click();

  // 清除保护后徽章回到歧义下限
  await page.locator('#clearProtectBtn').click();
  await page.waitForTimeout(200);
  const floored = await page.evaluate((center) => {
    const matte = document.getElementById('cvMatte') as HTMLCanvasElement;
    const d = matte.getContext('2d')!.getImageData(center.x, center.y, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, badge);
  expect(floored).toEqual([245, 165, 36]);

  // 换背景模式
  await page.locator('#bgMode').selectOption('gradient');
  await page.waitForTimeout(150);

  // 导出 + 解码抽查
  await page.locator('#exportBtn').click();
  await page.waitForSelector('#decodeStrip canvas', { timeout: 45_000 });
  await expect(page.locator('#decodeStrip canvas')).toHaveCount(3);
  const status = await page.locator('#exportStatus').textContent();
  expect(status).toContain('边缘MAE');
  expect(status).toContain('下载 WebM');

  // 解码抽查缩略图非空
  const decodedOk = await page.evaluate(() => {
    const cv = document.querySelector('#decodeStrip canvas') as HTMLCanvasElement;
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4096) sum += d[i] + d[i + 1] + d[i + 2];
    return sum > 0;
  });
  expect(decodedOk).toBe(true);

  expect(errors).toEqual([]);
  await browser.close();
});
