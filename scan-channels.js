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

async function resolveOne(channel, attempt = 1) {
    const path = "/api/resolve?url=" + encodeURIComponent(channel.url);
    try {
        const r = await getJson(path);

        if (r.ok && r.json && r.json.ok) {
            return { ok: true, kind: r.json.kind, contentType: r.json.contentType };
        }

        // 429 = bi rate limit -> cho roi thu lai (khong tinh la loi that).
        if (r.status === 429 && attempt < 5) {
            await new Promise(x => setTimeout(x, 1500 * attempt));
            return resolveOne(channel, attempt + 1);
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

// Do TUAN TU voi delay nho: tranh rate-limit 120 req/phut cua server.
async function scan(label, channels, skipped = 0) {
    const bad = [];
    let done = skipped;

    for (const ch of channels) {
        const r = await resolveOne(ch);
        done++;

        if (!r.ok) {
            bad.push({ ...ch, ...r });
        }

        if (done % 50 === 0) {
            console.log(`  ...${label}: ${done}/${skipped + channels.length} (loi: ${bad.length})`);
        }

        // Delay nho de khong vuot 120 req/phut.
        await new Promise(x => setTimeout(x, 550));
    }

    console.log(`----- ${label}: ${done} kênh, ${bad.length} kênh LỖI -----`);
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

    console.log("\n===== SCAN TV =====");
    const skipTv = Number(process.env.SKIP_TV) || 0;
    const badTv = await scan("TV", tv.slice(skipTv), skipTv);
    console.log("\n===== SCAN FOOTBALL =====");
    const badFb = await scan("FOOTBALL", fb);
    console.log("\n===== SCAN VN FOOTBALL =====");
    const badVn = await scan("VN FOOTBALL", vn);

    function summarize(label, bad, total) {
        console.log(`\n### ${label}: ${total - bad.length}/${total} OK (${bad.length} loi)`);

        const byErr = new Map();
        for (const b of bad) {
            const key = String(b.error || "?").slice(0, 60);
            byErr.set(key, (byErr.get(key) || 0) + 1);
        }

        // Nhom loi pho bien
        for (const [err, count] of [...byErr.entries()].sort((a,b)=>b[1]-a[1])) {
            console.log(`   [${count}] ${err}`);
        }

        // Liet ke ten kenh loi (toi da 40)
        for (const b of bad.slice(0, 40)) {
            console.log(`   - ${b.name} (${b.group}) -> ${b.error}`);
        }
        if (bad.length > 40) {
            console.log(`   ... va ${bad.length - 40} kenh nua`);
        }
    }

    console.log("\n========================================");
    console.log("TỔNG HỢP");
    console.log("========================================");
    summarize("TV", badTv, tv.length);
    summarize("FOOTBALL", badFb, fb.length);
    summarize("VN FOOTBALL", badVn, vn.length);
}

main().catch(e => { console.error("SCAN ERROR:", e); process.exit(1); });
