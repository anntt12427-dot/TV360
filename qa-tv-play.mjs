export default async function run(page, ui) {
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 300));
  });

  // Vào tab TV
  await page.click('#tvTab');
  await page.waitForFunction(
    () => {
      const l = document.getElementById('list');
      return l && l.querySelector('.channel');
    },
    { timeout: 40000 }
  ).catch(() => {});

  // Lấy danh sách kênh, bấm lần lượt từng kênh, đo thời gian và kết quả
  const results = [];
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('#list .channel .channel-name')].map(e => e.textContent).slice(0, 12)
  );

  for (const name of names) {
    const t0 = Date.now();
    // Bấm vào kênh theo tên
    await page.evaluate(n => {
      const cards = [...document.querySelectorAll('#list .channel')];
      const card = cards.find(c => c.querySelector('.channel-name')?.textContent === n);
      if (card) card.click();
    }, name);
    // Chờ tối đa 15s xem có "Đang phát" hay lỗi
    await page.waitForFunction(
      () => {
        const s = document.getElementById('status').textContent;
        const e = document.getElementById('error').textContent;
        return s.includes('Đang phát') || (e && e.length > 0);
      },
      { timeout: 15000 }
    ).catch(() => {});
    await page.waitForTimeout(6000);

    const st = await page.evaluate(() => ({
      status: document.getElementById('status').textContent,
      error: document.getElementById('error').textContent.slice(0, 250),
      videoPlaying: (() => {
        const v = document.getElementById('video');
        return !!(v && v.videoWidth > 0 && !v.paused);
      })()
    }));
    results.push({ name, seconds: ((Date.now() - t0) / 1000).toFixed(1), ...st });
  }

  return { results, errors: errors.slice(0, 20) };
}
