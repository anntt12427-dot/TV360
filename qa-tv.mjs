export default async function run(page, ui) {
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error') errors.push('CONSOLE: ' + m.text());
  });

  // Bấm tab TV
  await page.click('#tvTab');
  // Chờ playlist TV load (tối đa 40s vì server có thể gọi nguồn chậm)
  await page.waitForFunction(
    () => {
      const l = document.getElementById('list');
      return l && l.children.length > 0 && !l.querySelector('.skeleton');
    },
    { timeout: 40000 }
  ).catch(() => {});

  await page.waitForTimeout(3000);

  const state = await page.evaluate(() => {
    const l = document.getElementById('list');
    return {
      channelCount: l.querySelectorAll('.channel').length,
      listText: l.innerText.slice(0, 300),
      emptyText: (l.querySelector('.empty') || {}).textContent || ''
    };
  });

  return { state, errors: errors.slice(0, 20) };
}
