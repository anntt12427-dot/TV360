export default async function run(page, ui) {
  const seg = [];
  page.on("response", res => {
    const u = res.url();
    if (u.includes(".m4s")) seg.push(res.status());
  });

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

  const samples = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(3000);
    samples.push(await page.evaluate(() => {
      const v = document.getElementById("video");
      return { t: Math.round(v.currentTime), ready: v.readyState, paused: v.paused, muted: v.muted, vol: v.volume, buf: v.buffered.length ? Math.round(v.buffered.end(v.buffered.length - 1)) : 0 };
    }));
  }
  return { samples, segRequests: seg.length, segBad: seg.filter(x => x >= 400).length };
}
