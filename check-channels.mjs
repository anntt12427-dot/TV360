// Quet nhanh: resolve tung kenh qua API cua server, phan loai loi.
// Chay: node check-channels.mjs
const BASE = "http://localhost:3000";

async function fetchJson(url, timeoutMs = 25000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        return { status: res.status, json: await res.json().catch(() => null) };
    } finally {
        clearTimeout(t);
    }
}

async function main() {
    const { json } = await fetchJson(BASE + "/api/channels?type=tv", 60000);
    const channels = (json && json.channels) || [];
    console.log("TONG KENH:", channels.length);

    const results = [];
    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        try {
            const r = await fetchJson(BASE + "/api/resolve?url=" + encodeURIComponent(ch.url));
            const ok = r.json && r.json.ok;
            results.push({
                name: ch.name,
                ok,
                kind: r.json && (r.json.kind || ""),
                error: ok ? "" : ((r.json && r.json.error) || "HTTP " + r.status)
            });
        } catch (e) {
            results.push({ name: ch.name, ok: false, kind: "", error: "FETCH: " + e.message });
        }
        if ((i + 1) % 25 === 0) console.log("..." + (i + 1) + "/" + channels.length);
    }

    const dead = results.filter(r => !r.ok);
    const alive = results.filter(r => r.ok);
    console.log("\n=== SONG: " + alive.length + " / " + results.length + " ===");
    console.log("=== CHET: " + dead.length + " ===\n");

    // Nhom loi
    const byErr = new Map();
    for (const d of dead) {
        const key = String(d.error).slice(0, 60);
        if (!byErr.has(key)) byErr.set(key, []);
        byErr.get(key).push(d.name);
    }
    for (const [err, names] of byErr) {
        console.log("[LOI] " + err + "  (" + names.length + " kenh)");
        names.slice(0, 8).forEach(n => console.log("   - " + n));
        if (names.length > 8) console.log("   ... +" + (names.length - 8) + " kenh khac");
    }

    // Ghi file ket qua day du
    const fs = await import("fs");
    fs.writeFileSync("check-result.json", JSON.stringify({ alive: alive.map(a => a.name), dead }, null, 2));
    console.log("\nDa ghi ket qua vao check-result.json");
}

main();
