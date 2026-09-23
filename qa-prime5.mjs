export default async function run(page, ui) {
  await page.waitForTimeout(3000);
  const s = await ui.snapshot();
  const tv = s.match(/@(e\d+) button "📺 TV"/)?.[1];
  await ui.click(tv);
  await page.waitForFunction(() => document.querySelectorAll("#list .channel").length > 100, { timeout: 45000 });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const c = [...document.querySelectorAll("#list .channel")].find(x => x.querySelector(".channel-name")?.textContent.trim() === "VTVPrime 5");
    if (c) c.click();
  });

  // Do tien do video theo thoi gian de phat hien dung hinh
  const samples = [];
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(2500);
    samples.push(await page.evaluate(() => {
      const v = document.getElementById("video");
      return {
        t: Math.round(v.currentTime),
        ready: v.readyState,
        paused: v.paused,
        timeLabel: document.querySelector(".time-label")?.textContent.trim(),
        status: document.querySelector(".status")?.textContent.trim()
      };
    }));
  }

  return { samples };
}
