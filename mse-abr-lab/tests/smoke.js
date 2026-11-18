const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('PAGEERROR', error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('CONSOLE', message.text());
  });
  const profile = process.argv[2] || 'none';
  await page.goto(`http://127.0.0.1:8123/?profile=${profile}`, { waitUntil: 'networkidle0' });

  for (let tick = 0; tick < 60; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const stats = await page.evaluate(() => {
      const lab = window.__lab;
      return {
        next: lab.player.getStats().nextSegment,
        time: lab.video.currentTime,
        buffer: lab.player.getStats().bufferAhead,
        stalls: lab.player.getStats().stallCount,
        current: lab.abr.getState().currentIndex,
        reason: lab.abr.getState().lastDecision?.reason, kbps: Math.round((lab.abr.getState().throughputBps||0)/1000),
      };
    });
    console.log(JSON.stringify(stats));
    if (stats.next >= 8) break;
  }
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
