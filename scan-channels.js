// Script dò kênh TV + bóng đá: gọi /api/channels rồi /api/resolve cho từng kênh
// để phát hiện kênh không phát được. Chạy: node scan-channels.js
const PORT = Number(process.env.PORT) || 3000;
const BASE = `http://localhost:${PORT}`;

async function getJson(path, timeoutMs = 90000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(BASE + path, { signal: controller.signal });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { status: res.status, ok: res.ok, json, text };
    } finally {
        clearTimeout(timer);
    }
}

function flattenTv(payload) {
    const out = [];
    const channels = (payload && payload.channels) || [];
    for (const ch of channels) {
        out.push({ name: ch.name, group: ch.group || "", url: ch.url });
    }
    return out;
}

function flattenFootball(payload) {
    const out = [];
    const groups = (payload && payload.groups) || [];
    for (const g of groups) {
        for (const ch of (g.channels || [])) {
            out.push({ name: ch.name, group: g.name || "", url: ch.url });
        }
    }
    return out;
}

function flattenVnFootball(payload) {
    const out = [];
    const sites = (payload && payload.sites) || [];
    for (const s of sites) {
        for (const m of (s.matches || [])) {
            for (const st of (m.streams || [])) {
                out.push({
                    name: m.title + " (" + st.name + ")",
                    group: s.name || "",
                    url: st.url
                });
            }
        }
    }
    return out;
}

async function resolveOne(channel) {
    const path = "/api/resolve?url=" + encodeURIComponent(channel.url);
    try {
        const r = await getJson(path);
        if (r.ok && r.json && r.json.ok) {
            return { ok: true, kind: r.json.kind, contentType: r.json.contentType };
        }
        return {
            ok: false,
            status: r.status,
            kind: r.json && r.json.kind,
            error: (r.json && r.json.error) || ("HTTP " + r.status)
        };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

// Chạy tuần tự theo batch để không làm nghẽn server (rate limit).
async function scan(label, channels, concurrency = 2) {
    console.log(`\n===== SCAN ${label}: ${channels.length} kênh =====`);
    const bad = [];
    let done = 0;
    let index = 0;

    async function worker() {
        while (index < channels.length) {
            const i = index++;
            const ch = channels[i];
            const r = await resolveOne(ch);
            done++;
            if (!r.ok) {
                bad.push({ ...ch, ...r });
                console.log(`[FAIL] ${ch.name} | ${ch.group} | ${r.error}${r.kind ? " (" + r.kind + ")" : ""}`);
            } else {
                console.log(`[OK]   ${ch.name} | ${ch.group} | ${r.kind}`);
            }
        }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));

    console.log(`\n----- ${label}: ${done} kênh, ${bad.length} kênh LỖI -----`);
    return bad;
}

async function main() {
    console.log("Bắt đầu dò kênh...");

    const tvRes = await getJson("/api/channels?type=tv");
    const tv = tvRes.json ? flattenTv(tvRes.json) : [];
    console.log(`TV channels: ${tv.length}`);

    const fbRes = await getJson("/api/channels?type=football");
    const fb = fbRes.json ? flattenFootball(fbRes.json) : [];
    console.log(`Football channels: ${fb.length}`);

    const vnRes = await getJson("/api/channels?type=vnfootball");
    const vn = vnRes.json ? flattenVnFootball(vnRes.json) : [];
    console.log(`VN football streams: ${vn.length}`);

    const badTv = await scan("TV", tv);
    const badFb = await scan("FOOTBALL", fb);
    const badVn = await scan("VN FOOTBALL", vn);

    console.log("\n========================================");
    console.log("TỔNG HỢP KÊNH LỖI");
    console.log("========================================");
    console.log(`TV: ${badTv.length}/${tv.length}`);
    for (const b of badTv) console.log(`  - ${b.name} (${b.group}) -> ${b.error}`);
    console.log(`FOOTBALL: ${badFb.length}/${fb.length}`);
    for (const b of badFb) console.log(`  - ${b.name} (${b.group}) -> ${b.error}`);
    console.log(`VN FOOTBALL: ${badVn.length}/${vn.length}`);
    for (const b of badVn) console.log(`  - ${b.name} (${b.group}) -> ${b.error}`);
}

main().catch(e => { console.error("SCAN ERROR:", e); process.exit(1); });
