const express = require("express");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns");
const https = require("https");
const http = require("http");
const { Readable } = require("stream");
const zlib = require("zlib");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT) || 3000;
// Railway free: tat log chi tiet mac dinh, bat khi DEBUG=1. Ghi playlist ra file chi khi SAVE_PLAYLIST=1.
const DEBUG = process.env.DEBUG === "1";
const SAVE_PLAYLIST = process.env.SAVE_PLAYLIST === "1";
const log = (...a) => { if (DEBUG) console.log(...a); };
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 12000;
// Playlist (livesport...) co the phan hoi rat cham (>18s) -> cho lau hon.
const PLAYLIST_TIMEOUT_MS = Number(process.env.PLAYLIST_TIMEOUT_MS) || 30000;
const MAX_TEXT_BYTES = Number(process.env.MAX_TEXT_BYTES) || 3 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = Number(process.env.MAX_PLAYLIST_BYTES) || 5 * 1024 * 1024;
const MAX_PROXY_BYTES = Number(process.env.MAX_PROXY_BYTES) || 25 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 120;
// Proxy phát video: mỗi segment HLS/DASH là 1 request nên cần hạn mức riêng, rất rộng
// (nếu dùng chung 120/phút thì player sẽ bị 429 giữa chừng và đứng hình).
const PROXY_RATE_MAX = Number(process.env.PROXY_RATE_MAX) || 6000;
// Mot so nguon (TV360+ qua vmttv.dpdns.org) tra 404 xen ke 200 khi cache
// chua nong -> can nhieu lan thu moi on dinh.
const FETCH_ATTEMPTS = Number(process.env.FETCH_ATTEMPTS) || 4;
const rateBuckets = new Map();
function rateLimit(req, res, next) {
    try {
        // Không đếm static asset (index.html, logo...) để tiết kiệm CPU/bộ nhớ trên Railway free.
        if (!req.path.startsWith("/api/")) return next();

        const isProxy = req.path === "/api/proxy";
        const max = isProxy ? PROXY_RATE_MAX : RATE_LIMIT_MAX;

        const now = Date.now();
        const ip = String(req.ip || req.socket?.remoteAddress || "anon");
        const key = (isProxy ? "p:" : "a:") + ip;
        let b = rateBuckets.get(key);
        if (!b || now > b.reset) b = { count: 0, reset: now + RATE_LIMIT_WINDOW_MS };
        b.count++;
        rateBuckets.set(key, b);
        if (rateBuckets.size > 2000) {
            for (const [k, v] of rateBuckets) if (now > v.reset) rateBuckets.delete(k);
            if (rateBuckets.size > 2000) rateBuckets.clear();
        }
        if (b.count > max) {
            res.setHeader("Retry-After", Math.ceil((b.reset - now) / 1000));
            return res.status(429).json({ ok: false, error: "Too many requests, thử lại sau" });
        }
    } catch {}
    next();
}
app.use(rateLimit);
// Security + compression (không thêm dependency để nhẹ cho Railway free)
app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (req.path.startsWith("/api/")) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
    }
    next();
});
// Express 5 (path-to-regexp v8) khong con ho tro wildcard tran "/api/*";
// dung regex de bat moi OPTIONS duoi /api/.
app.options(/^\/api\/.*/, (req, res) => res.sendStatus(204));
function gzipMiddleware(req, res, next) {
    const accept = String(req.headers["accept-encoding"] || "");
    if (!/gzip/i.test(accept) || req.method !== "GET") return next();
    res.setHeader("Vary", "Accept-Encoding");
    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);
    res.json = body => {
        try {
            const buf = Buffer.from(JSON.stringify(body));
            if (buf.length < 1024) return origJson(body);
            res.setHeader("Content-Encoding", "gzip");
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.removeHeader("Content-Length");
            return origSend(zlib.gzipSync(buf));
        } catch { return origJson(body); }
    };
    next();
}
app.use(gzipMiddleware);

const DEFAULT_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36";

// ======================================================
// PLAYLIST
// ======================================================

const PLAYLISTS = {
    football: "https://livesport.s.gy/easport",
    tv: "https://tinyurl.com/vmt47",
    vnfootball: "https://tinyurl.com/ttthethao5"
};

// ======================================================
// CACHE
// ======================================================

const cache = {
    football: {
        time: 0,
        data: null
    },

    tv: {
        time: 0,
        data: null
    },

    vnfootball: {
        time: 0,
        data: null
    }
};

// Cache playlist 20 phut: nguon livesport phan hoi cham/dan khi goi lien tuc
// (co luc >18s) -> cache lau hon de giam so lan fetch upstream & tranh 502.
const CACHE_TIME = Number(process.env.CACHE_TIME_MS) || 20 * 60 * 1000;
// Cache MPD 5 phut de fix+verify chi fetch 1 lan (tiet kiem CPU/bandwidth Railway free)
const MPD_CACHE = new Map();
const MPD_CACHE_TIME = 5 * 60 * 1000;
function mpdCacheGet(url) {
    const e = MPD_CACHE.get(url);
    if (e && Date.now() - e.time < MPD_CACHE_TIME) return e.text;
    return null;
}
function mpdCacheSet(url, text) {
    if (MPD_CACHE.size > 100) MPD_CACHE.clear();
    MPD_CACHE.set(url, { time: Date.now(), text });
}

const FOOTBALL_HEADERS = {
    "User-Agent": "Lavf/61.7.100"
};

const playlistLoads = {
    football: null,
    tv: null,
    vnfootball: null
};

// Cac type dung header kieu VLC/FFmpeg + hydrate ClearKey.
const FOOTBALL_LIKE = new Set(["football", "vnfootball"]);

// ======================================================
// FETCH HELPER
// ======================================================

async function fetchText(url, headers = {}) {

    const response = await fetchResponse(url, headers);

    const text = await response.text();

    return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        headers: response.headers,
        text
    };
}

// ======================================================
// SMART FETCH: FALLBACK THEO TỪNG IP
// ======================================================
//
// Một số domain (ví dụ livesport.s.gy) có nhiều A record,
// trong đó có IP chết khiến fetch mặc định của Node bị
// ConnectTimeoutError ngẫu nhiên.
//
// Chiến lược:
// 1. Thử fetch bình thường trước.
// 2. Nếu lỗi kết nối (timeout/refused/...), resolve tất cả
//    IPv4 của hostname rồi thử lần lượt từng IP với
//    Host header + TLS SNI giữ nguyên hostname.
// 3. Tự theo dõi redirect (301/302/303/307/308).
// ======================================================

const HOST_IP_CACHE = new Map();

const HOST_IP_CACHE_TIME = 5 * 60 * 1000;

function resolveHostIps(hostname) {

    const cached = HOST_IP_CACHE.get(hostname);

    if (
        cached &&
        Date.now() - cached.time < HOST_IP_CACHE_TIME
    ) {
        return Promise.resolve(cached.ips);
    }

    return new Promise(resolve => {

        dns.resolve4(hostname, (error, addresses) => {

            const ips =
                (!error &&
                    Array.isArray(addresses) &&
                    addresses.length)
                    ? addresses
                    : [];

            HOST_IP_CACHE.set(hostname, {
                time: Date.now(),
                ips
            });

            resolve(ips);
        });
    });
}

function rawRequest(urlStr, ip, headers, timeoutMs, allowInsecure = false) {

    return new Promise((resolve, reject) => {

        const url = new URL(urlStr);

        const isHttps =
            url.protocol === "https:";

        const lib =
            isHttps ? https : http;

        const request = lib.request({
            host: ip,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: "GET",
            servername: isHttps ? url.hostname : undefined,
            // Chi bo qua verify khi ro rang la loi cert cua CDN stream
            // (nhieu nguon bong da free bi het han chung chi +- vo phuong).
            rejectUnauthorized: isHttps && !allowInsecure ? true : undefined,
            headers: {
                "Host": url.hostname,
                ...headers
            },
            timeout: timeoutMs
        }, resolve);

        if (isHttps && allowInsecure) {
            request.rejectUnauthorized = false;
        }

        request.on("timeout", () => {
            request.destroy(new Error("SOCKET_TIMEOUT"));
        });

        request.on("error", reject);

        request.end();
    });
}

function toFetchLikeResponse(incoming, finalUrl) {

    const responseHeaders = new Headers();

    for (
        const [key, value]
        of Object.entries(incoming.headers)
    ) {
        responseHeaders.set(
            key,
            Array.isArray(value)
                ? value.join(", ")
                : String(value)
        );
    }

    return {
        ok:
            incoming.statusCode >= 200 &&
            incoming.statusCode < 300,

        status:
            incoming.statusCode,

        url:
            finalUrl,

        headers:
            responseHeaders,

        text: () => new Promise((resolve, reject) => {
            let data = "";

            incoming.setEncoding("utf8");

            incoming.on("data", chunk => data += chunk);
            incoming.on("end", () => resolve(data));
            incoming.on("error", reject);
        }),

        body: Readable.toWeb(incoming)
    };
}

async function fetchWithIpFallback(
    urlStr,
    headers = {},
    timeoutMs = 20000,
    allowInsecure = false
) {
    let currentUrl = String(urlStr);

    let redirects = 0;

    let lastError = null;

    while (true) {

        const url = new URL(currentUrl);

        const ips =
            await resolveHostIps(url.hostname);

        const candidates =
            ips.length ? ips : [url.hostname];

        let redirected = false;

        for (
            const ip
            of candidates
        ) {
            try {

                const incoming = await rawRequest(
                    currentUrl,
                    ip,
                    {
                        "User-Agent": DEFAULT_UA,
                        "Accept": "*/*",
                        ...headers
                    },
                    timeoutMs,
                    allowInsecure
                );

                const status =
                    incoming.statusCode || 0;

                if (
                    [301, 302, 303, 307, 308].includes(status) &&
                    incoming.headers.location
                ) {
                    incoming.resume();

                    redirects++;

                    if (redirects > 5) {
                        throw new Error("TOO_MANY_REDIRECTS");
                    }

                    currentUrl = new URL(
                        incoming.headers.location,
                        currentUrl
                    ).toString();

                    redirected = true;

                    break;
                }

                return toFetchLikeResponse(
                    incoming,
                    currentUrl
                );

            } catch (error) {

                if (
                    error &&
                    error.message === "TOO_MANY_REDIRECTS"
                ) {
                    throw error;
                }

                lastError = error;
            }
        }

        if (!redirected) {
            throw lastError ||
                new Error("ALL_IP_FAILED");
        }
    }
}

// Loi chung chi TLS (cert het han, self-signed, sai ten mien...).
// Nhieu CDN stream bong da free bi het han cert -> van cho phep fallback.
function isCertError(error) {

    const codes = [
        "CERT_HAS_EXPIRED",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "CERT_UNTRUSTED",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
    ];

    let current = error;

    while (current) {

        if (codes.includes(current.code)) {
            return true;
        }

        if (
            typeof current.message === "string" &&
            /certificate|cert_has_expired|self.signed/i.test(
                current.message
            )
        ) {
            return true;
        }

        current = current.cause;
    }

    return false;
}

function isConnectError(error) {

    const codes = [
        "UND_ERR_CONNECT_TIMEOUT",
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "EAI_AGAIN"
    ];

    let current = error;

    while (current) {

        if (codes.includes(current.code)) {
            return true;
        }

        current = current.cause;
    }

    return false;
}

// ======================================================
// FETCH RESPONSE
// ======================================================

async function fetchWithTimeout(url, headers = {}, timeoutMs = FETCH_TIMEOUT_MS) {

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    try {
        return await fetch(url, {
            method: "GET",
            redirect: "follow",
            signal: controller.signal,

            headers: {
                "User-Agent": DEFAULT_UA,

                "Accept":
                    "*/*",

                ...headers
            }
        });
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchResponse(url, headers = {}, allowInsecure = false, timeoutMs = FETCH_TIMEOUT_MS) {

    try {
        return await fetchWithTimeout(url, headers, timeoutMs);
    } catch (error) {

        // Loi cert TLS (cert CDN het han) -> thu lai bo qua verify.
        // Khi da allowInsecure thi fetch() van co the throw cert error,
        // nen fallback thang bang rawRequest (co rejectUnauthorized=false).
        if (allowInsecure) {

            try {

                return await fetchWithIpFallback(
                    url,
                    headers,
                    FETCH_TIMEOUT_MS,
                    true
                );

            } catch (retryError) {

                if (isConnectError(retryError)) {
                    throw retryError;
                }

                throw error;
            }
        }

        if (isCertError(error)) {

            console.warn(
                "FETCH FALLBACK (BO QUA CERT):",
                url
            );

            return await fetchWithIpFallback(
                url,
                headers,
                FETCH_TIMEOUT_MS,
                true
            );
        }

        if (isConnectError(error)) {

            console.warn(
                "FETCH FALLBACK (THEO TUNG IP):",
                url
            );

            return await fetchWithIpFallback(
                url,
                headers,
                FETCH_TIMEOUT_MS,
                allowInsecure
            );
        }

        throw error;
    }
}

// Status coi la tam thoi (retry duoc): nhieu CDN/DDNS free tra 404 xen ke
// 200 khi cache chua kip lam nong (vi du TV360+ qua vmttv.dpdns.org).
function isRetryableStatus(status) {
    return status === 404 || status === 408 || status === 425 ||
        status === 429 || (status >= 500 && status < 600);
}

async function fetchResponseWithRetry(
    url,
    headers = {},
    attempts = FETCH_ATTEMPTS,
    allowInsecure = false,
    timeoutMs = FETCH_TIMEOUT_MS
) {
    let lastError;
    let lastResponse = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await fetchResponse(
                url,
                headers,
                allowInsecure,
                timeoutMs
            );

            // Neu upstream tra status tam thoi thi retry; dong body cua
            // response cu de giai phong socket truoc khi thu lai.
            if (
                attempt < attempts &&
                isRetryableStatus(response.status)
            ) {
                lastResponse = response;

                try {
                    await response.body?.cancel();
                } catch {}

                await new Promise(resolve =>
                    setTimeout(resolve, 250 * attempt)
                );

                continue;
            }

            return response;
        } catch (error) {
            lastError = error;

            if (attempt < attempts) {
                await new Promise(resolve =>
                    setTimeout(resolve, 250 * attempt)
                );
            }
        }
    }

    if (lastResponse) {
        return lastResponse;
    }

    throw lastError;
}

function proxyUrl(url, profile = "", referer = "") {
    return "/api/proxy?url=" +
        encodeURIComponent(url)
            .replace(/%24/g, "$") +
        (profile
            ? "&profile=" + encodeURIComponent(profile)
            : "") +
        (referer
            ? "&ref=" + encodeURIComponent(referer)
            : "");
}

function escapeXmlAttribute(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function rewriteHlsPlaylist(text, manifestUrl, referer = "") {
    return String(text || "")
        .split(/\r?\n/)
        .map(line => {
            const trimmed = line.trim();

            if (!trimmed || trimmed.startsWith("#")) {
                const uriMatch = line.match(/URI="([^"]+)"/i);

                if (!uriMatch) {
                    return line;
                }

                const absolute = new URL(
                    uriMatch[1],
                    manifestUrl
                ).toString();

                return line.replace(
                    uriMatch[1],
                    proxyUrl(absolute, "", referer)
                );
            }

            const absolute = new URL(
                trimmed,
                manifestUrl
            ).toString();

            return proxyUrl(absolute, "", referer);
        })
        .join("\n");
}

// Tinh thoi diem media LON NHAT (giay) trong toan bo SegmentTimeline.
// Dung de suy ra availabilityStartTime dung cho MPD live.
function getManifestMaxTime(text) {

    let maxSeconds = 0;

    const templateRe =
        /<SegmentTemplate\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/gi;

    let tMatch;

    while ((tMatch = templateRe.exec(text)) !== null) {

        const attrs = tMatch[1];
        const body = tMatch[2];

        const timescale =
            Number(/timescale="(\d+)"/i.exec(attrs)?.[1] || 1) || 1;

        const sRe = /<S\b([^>]*)\/?>/g;

        let sMatch;

        // Theo doi thoi diem hien tai TUAN TU: <S> khong co t se noi
        // tiep ngay sau <S> truoc do (khong reset ve 0).
        let cursor = 0;

        while ((sMatch = sRe.exec(body)) !== null) {

            const a = sMatch[1];

            const tAttr = /\bt="(\d+)"/.exec(a);
            const d = Number(/\bd="(\d+)"/.exec(a)?.[1] || 0);
            const r = Number(/\br="(\d+)"/.exec(a)?.[1] || 0);

            if (tAttr) {
                cursor = Number(tAttr[1]);
            }

            // <S> nay cong them (r + 1) lan d
            const lastT =
                cursor + (d * (r + 1));

            cursor = lastT;

            const seconds = lastT / timescale;

            if (seconds > maxSeconds) {
                maxSeconds = seconds;
            }
        }
    }

    return maxSeconds;
}

function rewriteDashManifest(text, manifestUrl, profile, referer = "", stripDrm = false) {
    let output = String(text || "");

    // Mot so nguon (TV360) khai ContentProtection nhung segment thuc te
    // KHONG ma hoa -> Shaka vao che do DRM roi loi 3016 (encrypted=0).
    // Khi biet chac la clear: go het ContentProtection de phat binh thuong.
    if (stripDrm) {

        output = output.replace(
            /<ContentProtection\b[\s\S]*?<\/ContentProtection>/gi,
            ""
        );

        output = output.replace(
            /<ContentProtection\b[^>]*\/>/gi,
            ""
        );
    }

    // ==================================================
    // MPD LIVE (type="dynamic")
    // ==================================================
    // GIU NGUYEN type="dynamic" + availabilityStartTime goc cua nguon.
    // Ly do: segment time (t/timescale) cua VTVPrime/TV360 duoc tinh
    // tu epoch (1970), nen AST=1970 la DUNG va khop voi t. Shaka se
    // tu reload MPD (minimumUpdatePeriod) -> lay segment moi lien tuc
    // -> khong dung hinh. (Truoc day chuyen sang static lam Shaka tai
    // het cua so segment ngan roi dung.)
    //
    // De timeline hien thi tu 0 (thay vi "29 trieu phut"), xu ly o
    // phia client bang seekRange().start (xem updateTimeLabel trong
    // index.html).

    const baseMatch = output.match(
        /<BaseURL[^>]*>([^<]+)<\/BaseURL>/i
    );

    const baseUrl = baseMatch
        ? new URL(baseMatch[1].trim(), manifestUrl).toString()
        : manifestUrl;

    output = output.replace(
        /(<AdaptationSet\b[\s\S]*?<\/AdaptationSet>)/gi,
        adaptation => {
            const templateMatch = adaptation.match(
                /<SegmentTemplate\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/i
            );

            if (!templateMatch) {
                return adaptation;
            }

            const templateAttributes = templateMatch[1];
            const templateBody = templateMatch[2];

            const makeTemplate = representationId => {
                const attrs = templateAttributes.replace(
                    /(initialization|media)="([^"]+)"/gi,
                    (match, attribute, value) => {
                        const expanded = value.replace(
                            /\$RepresentationID\$/g,
                            representationId
                        );

                        return attribute +
                            '="' +
                            escapeXmlAttribute(
                                proxyUrl(
                                    new URL(expanded, baseUrl).toString(),
                                    profile,
                                    referer
                                )
                            ) +
                            '"';
                    }
                );

                return "<SegmentTemplate" +
                    attrs +
                    ">" +
                    templateBody +
                    "</SegmentTemplate>";
            };

            let result = adaptation.replace(
                templateMatch[0],
                ""
            );

            // Dang 1: <Representation .../> (self-closing, thuong la video)
            result = result.replace(
                /<Representation\b([^>]*?)\/>/gi,
                (match, attributes) => {
                    const idMatch = attributes.match(/\bid="([^"]+)"/i);

                    if (!idMatch) {
                        return match;
                    }

                    return "<Representation" +
                        attributes +
                        ">" +
                        makeTemplate(idMatch[1]) +
                        "</Representation>";
                }
            );

            // Dang 2: <Representation ...>...</Representation>
            // (co con, thuong la audio voi AudioChannelConfiguration).
            // Phai xuyen qua ca AdaptationSet de bat dung cap the.
            result = result.replace(
                /<Representation\b([^>]*?)>([\s\S]*?)<\/Representation>/gi,
                (match, attributes, inner) => {
                    const idMatch = attributes.match(/\bid="([^"]+)"/i);

                    if (!idMatch) {
                        return match;
                    }

                    // Da co SegmentTemplate ben trong -> bo qua.
                    if (/<SegmentTemplate\b/i.test(inner)) {
                        return match;
                    }

                    return "<Representation" +
                        attributes +
                        ">" +
                        inner +
                        makeTemplate(idMatch[1]) +
                        "</Representation>";
                }
            );

            return result;
        }
    );

    output = output.replace(
        /<BaseURL[^>]*>[^<]+<\/BaseURL>/gi,
        ""
    );

    output = output.replace(
        /(initialization|media)="([^"]+)"/gi,
        (match, attribute, value) => {
            if (value.includes("/api/proxy?url=")) {
                return match;
            }

            if (value.includes("$RepresentationID$")) {
                return match;
            }

            // Proxy cả URL tuyệt đối (http/https) để tránh CORS khi
            // trình duyệt tải segment trực tiếp từ CDN nguồn.
            if (
                value.startsWith("http://") ||
                value.startsWith("https://")
            ) {
                return attribute +
                    '="' +
                    escapeXmlAttribute(
                        proxyUrl(value, profile, referer)
                    ) +
                    '"';
            }

            return attribute +
                '="' +
                proxyUrl(
                    new URL(value, manifestUrl).toString(),
                    profile,
                    referer
                ) +
                '"';
        }
    );

    return output;
}

// ======================================================
// NORMALIZE URL
// ======================================================

function normalizeUrl(url) {

    return String(url || "").trim();
}

// ======================================================
// NORMALIZE KID / KEY
// ======================================================
//
// Chuyển:
//
// 62cd4255-95ba-45b0-a3f8-0290510308b4
//
// thành:
//
// 62cd425595ba45b0a3f80290510308b4
//
// Shaka ClearKey cần dạng hex.
// ======================================================

function normalizeKey(value) {

    if (value === undefined || value === null) {
        return "";
    }

    const raw =
        String(value)
            .trim()
            .replace(/^["']|["']$/g, "")
            .replace(/\s+/g, "");

    if (!raw) {
        return "";
    }

    // Hex (cho phép dạng UUID có gạch ngang)
    const noDash = raw.replace(/-/g, "");

    if (
        /^[0-9a-fA-F]+$/.test(noDash) &&
        noDash.length % 2 === 0
    ) {

        return noDash.toLowerCase();
    }

    // Base64 / Base64URL (giữ nguyên - và _ để đổi sang + /)
    // Ví dụ TV360+13: hW8pGvNaXbe30MlEsymTuQ, qjVHVH8IT-TJ6lIG7_treA
    try {

        let base64 =
            raw
                .replace(/-/g, "+")
                .replace(/_/g, "/");

        while (base64.length % 4 !== 0) {
            base64 += "=";
        }

        const buffer =
            Buffer.from(base64, "base64");

        // Chỉ nhận đúng 16 byte (ClearKey 128-bit), tránh rác
        if (buffer.length === 16) {

            return buffer
                .toString("hex")
                .toLowerCase();
        }

    } catch {}

    return raw.toLowerCase();
}

// ======================================================
// CLEARKEY PARSER
// ======================================================

function parseClearKey(value) {

    const result = {};

    if (!value) {
        return result;
    }

    const isValidHexKey = text =>
        /^[0-9a-fA-F]{32}$/.test(String(text || "").trim());

    // Chuẩn hóa rồi kiểm tra đủ 16 byte (32 hex).
    // Chấp nhận cả hex 32 và base64/base64url của 16 byte
    // (TV360+13, MyTV dùng JWK base64url như hW8pGvNaXbe30MlEsymTuQ).
    const isValidKeyMaterial = text => {
        const hex = normalizeKey(text);
        return /^[0-9a-f]{32}$/.test(hex);
    };

    const text =
        String(value)
            .trim();

    if (!text) {
        return result;
    }

    // Một số endpoint trả nhiều JSON ClearKey, mỗi object một dòng.
    // Chuẩn hóa từng dòng riêng để tránh double-normalize khi
    // parseClearKey gọi lại chính nó với input đã chuẩn hóa.
    if (text.includes("\n")) {
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) {
                continue;
            }

            const normalized = normalizeKey(line.trim());
            if (normalized) {
                Object.assign(result, parseClearKey(normalized));
            }
        }

        if (Object.keys(result).length) {
            return result;
        }
    }

    // ==================================================
    // 1. JSON
    // ==================================================

    try {

        const json =
            JSON.parse(text);

        if (
            json &&
            typeof json === "object"
        ) {

            // ------------------------------------------
            // Dạng:
            //
            // {
            //   "kid": "key"
            // }
            // ------------------------------------------

            for (
                const [kid, key]
                of Object.entries(json)
            ) {

                if (
                    kid &&
                    key &&
                    typeof key !== "object" &&
                    kid !== "keys" &&
                    kid !== "type" &&
                    kid !== "kty" &&
                    isValidKeyMaterial(kid) &&
                    isValidKeyMaterial(key)
                ) {

                    const normalizedKid =
                        normalizeKey(kid);

                    const normalizedKey =
                        normalizeKey(key);

                    if (
                        normalizedKid &&
                        normalizedKey
                    ) {

                        result[normalizedKid] =
                            normalizedKey;
                    }
                }
            }

            // ------------------------------------------
            // Dạng JWK:
            //
            // {
            //   "keys": [
            //      {
            //          "kty":"oct",
            //          "k":"...",
            //          "kid":"..."
            //      }
            //   ]
            // }
            // ------------------------------------------

            if (
                Array.isArray(json.keys)
            ) {

                for (
                    const item
                    of json.keys
                ) {

                    if (
                        !item ||
                        !item.kid ||
                        !item.k ||
                        !isValidKeyMaterial(item.kid) ||
                        !isValidKeyMaterial(item.k)
                    ) {
                        continue;
                    }

                    const kid =
                        normalizeKey(
                            item.kid
                        );

                    const key =
                        normalizeKey(
                            item.k
                        );

                    if (
                        kid &&
                        key
                    ) {

                        result[kid] = key;
                    }
                }
            }

            if (
                Object.keys(result).length
            ) {

                return result;
            }
        }

    } catch {}

    // ==================================================
    // 2. kid:key
    // ==================================================
    //
    // kid:key
    // kid=key
    //
    // Có thể có nhiều cặp:
    //
    // kid1:key1,kid2:key2
    //
    // ==================================================

    const pairs =
        text.split(/[;,]/);

    for (
        const pair
        of pairs
    ) {

        const clean =
            pair.trim();

        if (!clean) {
            continue;
        }

        const separator =
            clean.indexOf(":") !== -1
                ? ":"
                : "=";

        const index =
            clean.indexOf(separator);

        if (index === -1) {
            continue;
        }

        const rawKid =
            clean
                .slice(0, index)
                .trim();

        const rawKey =
            clean
                .slice(index + 1)
                .trim();

        // Chỉ nhận cặp KID:KEY đủ 16 byte (hex 32 hoặc base64 22).
        // (tránh nhặt rác từ JSON hỏng / text lạ).

        if (
            !isValidKeyMaterial(rawKid) ||
            !isValidKeyMaterial(rawKey)
        ) {
            continue;
        }

        const kid =
            normalizeKey(rawKid);

        const key =
            normalizeKey(rawKey);

        if (
            kid &&
            key
        ) {

            result[kid] = key;
        }
    }

    return result;
}

// ======================================================
// EXTRACT MPD KIDS
// ======================================================

function extractMPDKids(text) {

    const kids =
        new Set();

    if (!text) {
        return [];
    }

    const s =
        String(text);

    // ==================================================
    // Các dạng thường gặp
    // ==================================================

    const patterns = [

        // default_KID="..."
        /default_KID\s*=\s*["']([^"'"\s]+)/gi,

        // default_KID=...
        /default_KID\s*=\s*([0-9a-fA-F-]{32,36})/gi,

        // cenc:default_KID="..."
        /cenc:default_KID\s*=\s*["']([^"'"\s]+)/gi,

        // cenc:default_KID=...
        /cenc:default_KID\s*=\s*([0-9a-fA-F-]{32,36})/gi
    ];

    for (
        const regex
        of patterns
    ) {

        let match;

        while (
            (match = regex.exec(s)) !== null
        ) {

            // Chuẩn hóa ngay theo có gạch ngang (UUID), sau đó
            // mới kiểm tra -> tránh nhìn nhận mảnh rác làm KID.
            const rawKid = String(match[1] || "").trim();

            if (!rawKid || rawKid.length < 32) {
                continue;
            }

            const kid = normalizeKey(rawKid);

            if (!kid || kid.length < 32) {
                continue;
            }

            kids.add(kid);
        }
    }

    return [...kids];
}

// ======================================================
// FIND MPD CONTENT PROTECTION
// ======================================================

function inspectMPD(text) {

    const result = {

        kids: [],

        hasClearKey: false,

        hasWidevine: false,

        hasPlayReady: false
    };

    if (!text) {
        return result;
    }

    const s =
        String(text);

    result.kids =
        extractMPDKids(s);

    if (
        /clearkey/i.test(s)
    ) {

        result.hasClearKey = true;
    }

    if (
        /edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/i.test(s)
    ) {

        result.hasWidevine = true;
    }

    if (
        /9a04f079-9840-4286-ab92-e65be0885f95/i.test(s)
    ) {

        result.hasPlayReady = true;
    }

    return result;
}

// ======================================================
// FIX CLEARKEY KID THEO MPD
// ======================================================

async function fixClearKeysForMPD(
    mpdUrl,
    clearKeys,
    headers = {}
) {

    const original = {
        ...(clearKeys || {})
    };

    if (!mpdUrl) {
        return original;
    }

    if (
        !Object.keys(original).length
    ) {

        return original;
    }

    try {

        console.log(
            "=========================================="
        );

        console.log(
            "CLEARKEY FIX: ĐỌC MPD"
        );

        console.log(
            "MPD:",
            mpdUrl
        );

        let mpdText = mpdCacheGet(mpdUrl);
        if (!mpdText) {
            const r =
                await fetchText(
                    mpdUrl,
                    headers
                );

            if (!r.ok) {

                console.warn(
                    "CLEARKEY FIX: MPD HTTP",
                    r.status
                );

                return original;
            }
            mpdText = r.text;
            mpdCacheSet(mpdUrl, mpdText);
        }

        const mpdInfo =
            inspectMPD(
                mpdText
            );

        const mpdKids =
            mpdInfo.kids;

        console.log(
            "MPD KIDS:",
            mpdKids
        );

        console.log(
            "PLAYLIST KIDS:",
            Object.keys(original)
        );

        console.log(
            "MPD CLEARKEY:",
            mpdInfo.hasClearKey
        );

        console.log(
            "MPD WIDEVINE:",
            mpdInfo.hasWidevine
        );

        console.log(
            "MPD PLAYREADY:",
            mpdInfo.hasPlayReady
        );

        // ==================================================
        // Không tìm được KID trong MPD
        // ==================================================

        if (!mpdKids.length) {

            console.warn(
                "CLEARKEY FIX: Không tìm thấy KID trong MPD"
            );

            return original;
        }

        // ==================================================
        // Kiểm tra KID đã khớp
        // ==================================================

        const matched =
            mpdKids.some(
                kid =>
                    Object.hasOwn(original, kid) ||
                    (original[kid] !== undefined)
            );

        if (matched) {

            console.log(
                "CLEARKEY FIX: KID ĐÃ KHỚP"
            );

            return original;
        }

        // ==================================================
        // Trường hợp chỉ có 1 KID + 1 key
        // ==================================================

        const playlistKids =
            Object.keys(original);

        if (
            mpdKids.length === 1 &&
            playlistKids.length === 1
        ) {

            const oldKid =
                playlistKids[0];

            const key =
                original[oldKid];

            const newKid =
                mpdKids[0];

            console.log(
                "CLEARKEY FIX: ĐỔI KID"
            );

            console.log(
                "OLD KID:",
                oldKid
            );

            console.log(
                "NEW KID:",
                newKid
            );

            console.log(
                "KEY:",
                key
            );

            return {
                [newKid]: key
            };
        }

        // ==================================================
        // Nếu có nhiều KID, thử tìm quan hệ trong MPD
        // ==================================================

        console.warn(
            "CLEARKEY FIX: Có nhiều KID, không tự ý ghép key"
        );

        return original;

    } catch (err) {

        console.warn(
            "CLEARKEY FIX ERROR:",
            err.message
        );

        return original;
    }
}

// ======================================================
// VERIFY DASH KEYS THEO MPD (chống Shaka 4012)
// ======================================================
//
// Sau khi fix, tải lại MPD và đối chiếu KID.
// Nếu MPD cần KID mà playlist không có -> trả về
// missingKids để API báo lỗi thân thiện thay vì
// để Shaka nổ Error 4012 missingKeys.
//

async function verifyDashKeys(mpdUrl, clearKeys, headers = {}) {
    try {
        let mpdText = mpdCacheGet(mpdUrl);
        if (!mpdText) {
            const r = await fetchText(mpdUrl, headers);
            if (!r.ok) return { ok: true };
            mpdText = r.text;
            mpdCacheSet(mpdUrl, mpdText);
        }
        const info = inspectMPD(mpdText);
        if (!info.kids.length) return { ok: true };
        const have = new Set(Object.keys(clearKeys || {}));
        const missing = info.kids.filter(k => !have.has(k));
        if (!missing.length) return { ok: true, kids: info.kids };
        return { ok: false, kids: info.kids, missing };
    } catch (e) {
        return { ok: true };
    }
}

// ======================================================
// PARSE M3U
// ======================================================

// ======================================================
// LOC TRAN THEO GIO THI DAU (ten kenh dang "🟢 17:15 18/09 ...")
// ======================================================
// Tra ve true neu tran da bat dau qua lau (qua MATCH_MAX_AGE_MS).
// Neu khong doc duoc gio thi coi nhu con hien (khong loai).

const MATCH_MAX_AGE_MS =
    Number(process.env.MATCH_MAX_AGE_HOURS || 3) * 60 * 60 * 1000;

// Mui gio Viet Nam (UTC+7) co dinh tren server de nhat quan.
const VN_TZ_OFFSET_MS = 7 * 60 * 60 * 1000;

function isMatchExpired(name, nowMs = Date.now()) {

    const text = String(name || "");

    // Bat dang "HH:MM DD/MM" (co the co ky tu trang tri phia truoc).
    const match = text.match(
        /(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})/
    );

    // Khong co thong tin gio -> giu lai.
    if (!match) {
        return false;
    }

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const day = Number(match[3]);
    const month = Number(match[4]);

    if (
        hour > 23 || minute > 59 ||
        day < 1 || day > 31 ||
        month < 1 || month > 12
    ) {
        return false;
    }

    // Gio thi dau ghi theo mui VN (UTC+7); khong co nam trong ten nen
    // lay nam hien tai theo mui VN.
    const nowVN = new Date(nowMs + VN_TZ_OFFSET_MS);
    const year = nowVN.getUTCFullYear();

    const startUtc =
        Date.UTC(year, month - 1, day, hour, minute) -
        VN_TZ_OFFSET_MS;

    // Neu tran nam o tuong lai xa (co the la nam sau) thi coi nhu
    // chua expired.
    if (startUtc - nowMs > MATCH_MAX_AGE_MS) {
        return false;
    }

    return nowMs - startUtc > MATCH_MAX_AGE_MS;
}

// ======================================================
// PARSE TEN TRAN / BLV
// ======================================================
// Ten dang: "🟢 18:35 18/09 ⚽ Zhejiang FC vs Wuhan (BLV TAP) [FHD] [hls]"
// -> { time: "18:35 18/09", title: "Zhejiang FC vs Wuhan", blv: "BLV TAP" }

function parseMatchTitle(rawName) {

    const raw = String(rawName || "").trim();

    let rest = raw;

    // 1. Lay gio thi dau "HH:MM DD/MM" (neu co).
    let time = "";

    const timeMatch = rest.match(/(\d{1,2}:\d{2}\s+\d{1,2}\/\d{1,2})/);

    if (timeMatch) {
        time = timeMatch[1];
        rest = rest.slice(timeMatch.index + timeMatch[0].length);
    }

    // 2. Bo cac tag dang [FHD], [hls], [FHD1]...
    let blv = "";
    const blvMatch = rest.match(/\(([^)]*)\)/);

    if (blvMatch) {
        blv = blvMatch[1].trim();
        rest = rest.slice(0, blvMatch.index) + rest.slice(blvMatch.index + blvMatch[0].length);
    }

    // 3. Don sach emoji / ky hieu dau ten, bo tag [...]
    let title = rest
        .replace(/\[[^\]]*\]/g, "")
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D]/gu, "")
        .replace(/\s+/g, "\x20")
        .trim();

    if (!title) {
        title = raw;
    }

    return { time, title, blv };
}

// Khoa gom tran: ten tran (bo BLV, bo gio) da chuan hoa.
function matchGroupKey(title) {
    return String(title || "")
        .toLowerCase()
        .replace(/\s+/g, "\x20")
        .trim();
}

function parseM3U(text) {

    const lines =
        String(text || "")
            .split(/\r?\n/)
            .map(x => x.trim());

    const channels = [];

    let current = null;

    let pendingHeaders = {};

    for (
        const line
        of lines
    ) {

        if (!line) {
            continue;
        }

        // ==================================================
        // EXTINF
        // ==================================================

        if (
            line.startsWith(
                "#EXTINF:"
            )
        ) {

            const commaIndex =
                line.indexOf(",");

            let info =
                line;

            if (
                commaIndex !== -1
            ) {

                info =
                    line.slice(
                        0,
                        commaIndex
                    );
            }

            const name =
                commaIndex !== -1
                    ? line
                        .slice(
                            commaIndex + 1
                        )
                        .trim()
                    : "Unknown";

            const getAttr =
                attr => {

                    const regex =
                        new RegExp(
                            attr +
                            '="([^"]*)"',
                            "i"
                        );

                    const match =
                        info.match(
                            regex
                        );

                    return match
                        ? match[1]
                        : "";
                };

            current = {

                name:
                    name ||
                    getAttr("tvg-name") ||
                    "Unknown",

                logo:
                    getAttr("tvg-logo"),

                group:
                    getAttr("group-title"),

                tvgId:
                    getAttr("tvg-id"),

                url: "",

                headers: {},

                clearKeys: {}
            };

            pendingHeaders = {};

            continue;
        }

        // ==================================================
        // KODIPROP
        // ==================================================

        if (
            line.startsWith(
                "#KODIPROP:"
            )
        ) {

            if (!current) {
                continue;
            }

            const value =
                line.slice(
                    "#KODIPROP:".length
                );

            const split =
                value.indexOf("=");

            if (split === -1) {
                continue;
            }

            const key =
                value
                    .slice(
                        0,
                        split
                    )
                    .trim();

            const val =
                value
                    .slice(
                        split + 1
                    )
                    .trim();

            const lowerKey =
                key.toLowerCase();

            // ==================================================
            // ClearKey
            // ==================================================

            if (
                lowerKey.includes(
                    "license_key"
                ) ||
                lowerKey.includes(
                    "license-key"
                ) ||
                lowerKey.includes(
                    "clearkey"
                )
            ) {
                if (/^https?:\/\//i.test(val)) {
                    current.licenseUrl = val;
                } else {
                    Object.assign(
                        current.clearKeys,
                        parseClearKey(val)
                    );
                }
            }

            // ==================================================
            // Có thể KODIPROP chứa header
            // ==================================================

            if (
                lowerKey ===
                "inputstream.adaptive.stream_headers"
            ) {

                const headerParts =
                    val.split("&");

                for (
                    const part
                    of headerParts
                ) {

                    const idx =
                        part.indexOf("=");

                    if (
                        idx === -1
                    ) {
                        continue;
                    }

                    const headerName =
                        decodeURIComponent(
                            part.slice(
                                0,
                                idx
                            )
                        );

                    const headerValue =
                        decodeURIComponent(
                            part.slice(
                                idx + 1
                            )
                        );

                    if (
                        headerName &&
                        headerValue
                    ) {

                        current.headers[
                            headerName
                        ] = headerValue;
                    }
                }
            }

            continue;
        }

        // ==================================================
        // EXTHTTP
        // ==================================================

        if (
            line.startsWith(
                "#EXTHTTP:"
            )
        ) {

            if (!current) {
                continue;
            }

            const value =
                line.slice(
                    "#EXTHTTP:".length
                );

            try {

                const json =
                    JSON.parse(
                        value
                    );

                if (
                    json &&
                    typeof json === "object"
                ) {

                    for (
                        const [key, val]
                        of Object.entries(
                            json
                        )
                    ) {

                        current.headers[key] =
                            String(val);
                    }
                }

            } catch {

                console.warn(
                    "EXTHTTP không phải JSON:",
                    value
                );
            }

            continue;
        }

        // ==================================================
        // EXT VLC REFERRER
        // ==================================================

        if (
            line.startsWith(
                "#EXTVLCOPT:http-referrer="
            )
        ) {

            if (current) {

                current.headers.Referer =
                    line
                        .slice(
                            "#EXTVLCOPT:http-referrer=".length
                        )
                        .trim();
            }

            continue;
        }

        // ==================================================
        // EXT VLC USER AGENT
        // ==================================================

        if (
            line.startsWith(
                "#EXTVLCOPT:http-user-agent="
            )
        ) {

            if (current) {

                current.headers[
                    "User-Agent"
                ] =
                    line
                        .slice(
                            "#EXTVLCOPT:http-user-agent=".length
                        )
                        .trim();
            }

            continue;
        }

        // ==================================================
        // EXT VLC HTTP HEADER
        // ==================================================

        if (
            line.startsWith(
                "#EXTVLCOPT:http-header="
            )
        ) {

            if (current) {

                const value =
                    line
                        .slice(
                            "#EXTVLCOPT:http-header=".length
                        );

                const idx =
                    value.indexOf("=");

                if (
                    idx !== -1
                ) {

                    const headerName =
                        value
                            .slice(
                                0,
                                idx
                            )
                            .trim();

                    const headerValue =
                        value
                            .slice(
                                idx + 1
                            )
                            .trim();

                    if (
                        headerName
                    ) {

                        current.headers[
                            headerName
                        ] =
                            headerValue;
                    }
                }
            }

            continue;
        }

        // ==================================================
        // NORMAL URL
        // ==================================================

        if (
            !line.startsWith("#")
        ) {

            if (!current) {
                continue;
            }

            // Mot so playlist ghi "None"/"null" thay cho URL khi tran
            // chua co stream -> bo qua de khong hien kenh chet len UI.
            // Dong thoi bo cac URL placeholder "no-signal" (BLV chua
            // co luong that, vi du freem3u.xyz/static/no-signal/...).
            if (
                /^(?:none|null|n\/a|-)$/i.test(line) ||
                /\/no-signal\//i.test(line)
            ) {
                current = null;
                pendingHeaders = {};
                continue;
            }

            current.url =
                line;

            channels.push({

                ...current,

                headers: {
                    ...current.headers,
                    ...pendingHeaders
                },

                clearKeys: {
                    ...current.clearKeys
                },

                licenseUrl:
                    current.licenseUrl ||
                    ""
            });

            current = null;

            pendingHeaders = {};
        }
    }

    return channels;
}

async function hydratePlaylistKeys(channels) {
    const urls = [
        ...new Set(
            channels
                .map(channel => channel.licenseUrl)
                .filter(Boolean)
        )
    ];

    const loaded = new Map();

    for (const url of urls) {
        try {
            const response = await fetchText(
                url,
                FOOTBALL_HEADERS
            );

            if (response.ok) {
                loaded.set(
                    url,
                    parseClearKey(response.text)
                );
            }
        } catch (error) {
            console.warn(
                "CLEARKEY URL ERROR:",
                url,
                error.message
            );
        }
    }

    for (const channel of channels) {
        const keys = loaded.get(channel.licenseUrl);

        if (keys && Object.keys(keys).length) {
            channel.clearKeys = keys;
        }
    }

    return channels;
}

// ======================================================
// LOAD PLAYLIST
// ======================================================

async function loadPlaylist(
    type,
    force = false
) {
    if (playlistLoads[type]) {
        return playlistLoads[type];
    }

    const loading = fetchPlaylist(type, force);
    playlistLoads[type] = loading;

    try {
        return await loading;
    } finally {
        if (playlistLoads[type] === loading) {
            playlistLoads[type] = null;
        }
    }
}

async function fetchPlaylist(
    type,
    force = false
) {

    if (!PLAYLISTS[type]) {

        throw new Error(
            "Playlist không tồn tại: " +
            type
        );
    }

    const now =
        Date.now();

    if (
        !force &&
        cache[type].data &&
        now - cache[type].time <
            CACHE_TIME
    ) {

        return cache[type].data;
    }

    console.log(
        "=========================================="
    );

    console.log(
        "LOAD PLAYLIST:",
        type
    );

    console.log(
        PLAYLISTS[type]
    );

    const response =
        await fetchResponseWithRetry(
            PLAYLISTS[type],
            FOOTBALL_LIKE.has(type)
                ? {
                    // Livesport trả video mồi cho Chrome nhưng trả M3U
                    // đầy đủ khi được gọi như VLC/FFmpeg.
                    "User-Agent": "Lavf/61.7.100"
                }
                : {},
            // Playlist cham/chap chon -> thu vai lan.
            FETCH_ATTEMPTS,
            // Cho phep bo qua verify khi CDN playlist het cert (nhu vnfootball).
            FOOTBALL_LIKE.has(type),
            // Playlist co the rat cham -> cho timeout dai hon.
            PLAYLIST_TIMEOUT_MS
        );

    const contentType = String(
        response.headers.get("content-type") || ""
    ).toLowerCase();

    const finalUrl = String(
        response.url || PLAYLISTS[type]
    );

    if (!response.ok) {
        await response.body?.cancel();

        throw new Error(
            `Playlist HTTP ${response.status}`
        );
    }

    // Một số nguồn gọi là playlist nhưng redirect thẳng tới video MP4.
    if (
        contentType.startsWith("video/") ||
        /\.(?:mp4|webm|m4v|mov)(?:\?|$)/i.test(finalUrl)
    ) {
        await response.body?.cancel();

        const directChannel = [{
            name: FOOTBALL_LIKE.has(type) ? "Livesport" : "TV trực tiếp",
            logo: "",
            group: FOOTBALL_LIKE.has(type) ? "Livesport" : "Nguồn trực tiếp",
            tvgId: "",
            url: finalUrl,
            headers: {},
            clearKeys: {}
        }];

        cache[type] = {
            time: now,
            data: directChannel
        };

        console.log("DIRECT VIDEO SOURCE:", finalUrl);
        return directChannel;
    }

    const result = {
        ok: response.ok,
        status: response.status,
        url: finalUrl,
        headers: response.headers,
        text: await response.text()
    };

log("FINAL URL:", result.url);
log("HTTP:", result.status);

if (SAVE_PLAYLIST) {
    try {
        require("fs").writeFileSync(
            "playlist-test.txt",
            result.text
        );
    } catch {}
}

    const channels =
        parseM3U(
            result.text
        );

    if (FOOTBALL_LIKE.has(type)) {
        await hydratePlaylistKeys(channels);
    }

    console.log(
        "PLAYLIST CHANNELS:",
        channels.length
    );

    cache[type] = {

        time: now,

        data: channels
    };

    return channels;
}

// ======================================================
// STREAM TYPE DETECTOR
// ======================================================

async function detectStreamType(url, headers = {}) {
    const cleanUrl = normalizeUrl(url);

    console.log("==========================================");
    console.log("STREAM DETECT:");
    console.log("URL:", cleanUrl);

    try {
        const result = await fetchResponseWithRetry(
            cleanUrl,
            headers
        );

        const contentType = String(
            result.headers.get("content-type") || ""
        ).toLowerCase();

        const finalUrl = String(
            result.url || cleanUrl
        );

        let body = "";
        let sample = "";

        console.log("DETECT HTTP:", result.status);
        console.log("DETECT FINAL URL:", finalUrl);
        console.log("DETECT CONTENT-TYPE:", contentType);

        // ==================================================
        // QUAN TRỌNG:
        // Nếu HTTP lỗi thì KHÔNG được suy ra loại stream
        // từ extension của URL redirect.
        // ==================================================

        if (!result.ok) {
            await result.body?.cancel();

            console.log(
                "STREAM DETECT RESULT: upstream_error"
            );

            return {
                kind: "upstream_error",
                finalUrl: cleanUrl,
                contentType,
                status: result.status,
                errorUrl: finalUrl
            };
        }

        // Luồng sống không có điểm kết thúc, không được gọi response.text().
        if (contentType.startsWith("video/")) {
            await result.body?.cancel();

            return {
                kind: "video",
                finalUrl,
                contentType,
                status: result.status
            };
        }

        if (
            contentType.includes("application/vnd.apple.mpegurl") ||
            contentType.includes("application/x-mpegurl") ||
            contentType.includes("audio/mpegurl") ||
            /\.m3u8(?:\?|$)/i.test(finalUrl)
        ) {
            await result.body?.cancel();

            return {
                kind: "hls",
                finalUrl,
                contentType,
                status: result.status
            };
        }

        if (
            contentType.includes("application/dash+xml") ||
            /\.mpd(?:\?|$)/i.test(finalUrl)
        ) {
            await result.body?.cancel();

            return {
                kind: "dash",
                finalUrl,
                contentType,
                status: result.status
            };
        }

        if (
            /\.(?:mp4|webm|ogg|ogv|mov|m4v|ts)(?:\?|$)/i.test(finalUrl)
        ) {
            await result.body?.cancel();

            return {
                kind: "video",
                finalUrl,
                contentType,
                status: result.status
            };
        }

        body = String(await result.text()).trim();
        sample = body.slice(0, 20000).toLowerCase();

        // ==================================================
        // HLS
        // ==================================================

        if (
            contentType.includes(
                "application/vnd.apple.mpegurl"
            ) ||
            contentType.includes(
                "application/x-mpegurl"
            ) ||
            contentType.includes(
                "audio/mpegurl"
            ) ||
            sample.startsWith("#extm3u") ||
            sample.includes("#ext-x-stream-inf") ||
            /\.m3u8(?:\?|$)/i.test(finalUrl)
        ) {
            console.log(
                "STREAM DETECT RESULT: hls"
            );

            return {
                kind: "hls",
                finalUrl,
                contentType,
                status: result.status
            };
        }

        // ==================================================
        // DASH
        // ==================================================

        if (
            contentType.includes(
                "application/dash+xml"
            ) ||
            /<mpd[\s>]/i.test(body) ||
            sample.includes(
                "urn:mpeg:dash:schema:mpd"
            ) ||
            /\.mpd(?:\?|$)/i.test(finalUrl)
        ) {
            console.log(
                "STREAM DETECT RESULT: dash"
            );

            return {
                kind: "dash",
                finalUrl,
                contentType,
                status: result.status
            };
        }

        // ==================================================
        // DIRECT VIDEO
        // ==================================================

        // Chỉ nhận video khi:
        //
        // 1. HTTP thành công
        // 2. Content-Type thực sự là video/*
        //
        // Không dựa đơn thuần vào .mp4 nữa.

        if (
            contentType.startsWith("video/")
        ) {
            console.log(
                "STREAM DETECT RESULT: video"
            );

            return {
                kind: "video",
                finalUrl,
                contentType,
                status: result.status
            };
        }

        // Một số server không trả Content-Type chuẩn,
        // lúc đó mới dùng extension.

        if (
            /\.(?:mp4|webm|ogg|ogv|mov|m4v)(?:\?|$)/i.test(
                finalUrl
            )
        ) {
            console.log(
                "STREAM DETECT RESULT: video"
            );

            return {
                kind: "video",
                finalUrl,
                contentType,
                status: result.status
            };
        }

        // ==================================================
        // UNKNOWN
        // ==================================================

        console.log(
            "STREAM DETECT RESULT: unknown"
        );

        return {
            kind: "unknown",
            finalUrl,
            contentType,
            status: result.status
        };

    } catch (error) {

        console.error(
            "STREAM DETECT ERROR:",
            error.message
        );

        return {
            kind: "network_error",
            finalUrl: cleanUrl,
            contentType: "",
            status: 0,
            error: error.message
        };
    }
}

// ======================================================
// CHANNEL FINDER
// ======================================================

async function findChannelByUrl(url) {

    const target =
        normalizeUrl(url);

    // Tim trong ca 3 nguon: TV, the thao quoc te, bong da VN.
    // (Bong da VN can header Referer/Origin tu #EXTVLCOPT, neu
    // khong tim thay channel thi header rong -> upstream tra 403.)
    for (
        const type of [
            "tv",
            "football",
            "vnfootball"
        ]
    ) {

        try {

            const channels =
                await loadPlaylist(
                    type
                );

            const found =
                channels.find(
                    channel =>
                        normalizeUrl(
                            channel.url
                        ) === target
                );

            if (found) {
                return found;
            }

        } catch (error) {

            console.warn(
                "findChannelByUrl(" +
                type +
                "):",
                error.message
            );
        }
    }

    return null;
}

// ======================================================
// API: CHANNELS
// ======================================================

app.get(
    "/api/channels",
    async (req, res) => {

        try {

            const type =
                req.query.type === "tv"
                    ? "tv"
                    : req.query.type === "vnfootball"
                        ? "vnfootball"
                        : "football";

            const channels =
                await loadPlaylist(
                    type
                );

            // ==================================================
            // TV
            // ==================================================

            if (
                type === "tv"
            ) {

                return res.json({

                    ok: true,

                    channels
                });
            }

            // ==================================================
            // VN FOOTBALL
            // ==================================================
            // Tra ve cac "website" (Gio Vang, Chuoi Chien...); moi
            // website gom cac tran; moi tran gom nhieu luong (BLV).
            // - Loc tran da bat dau qua lau (> 3 tieng).
            // - Gom cac link cung tran (cung cap doi) lai lam 1.
            // ==================================================

            if (
                type === "vnfootball"
            ) {

                const nowVN = Date.now();

                // siteName -> (matchKey -> match)
                const siteMap = new Map();

                for (
                    const channel of channels
                ) {

                    if (
                        isMatchExpired(
                            channel.name,
                            nowVN
                        )
                    ) {
                        continue;
                    }

                    const site =
                        String(
                            channel.group ||
                            "Khác"
                        ).trim();

                    if (!site) {
                        continue;
                    }

                    const parsed =
                        parseMatchTitle(
                            channel.name
                        );

                    const key =
                        matchGroupKey(
                            parsed.title
                        );

                    if (!siteMap.has(site)) {

                        siteMap.set(
                            site,
                            {
                                name:
                                    site,

                                logo:
                                    channel.logo ||
                                    "",

                                matches:
                                    new Map()
                            }
                        );
                    }

                    const siteEntry =
                        siteMap.get(site);

                    if (
                        !siteEntry.logo &&
                        channel.logo
                    ) {

                        siteEntry.logo =
                            channel.logo;
                    }

                    if (
                        !siteEntry.matches.has(
                            key
                        )
                    ) {

                        siteEntry.matches.set(
                            key,
                            {
                                id:
                                    crypto
                                        .createHash("md5")
                                        .update(site + "|" + key)
                                        .digest("hex")
                                        .slice(0, 12),

                                title:
                                    parsed.title,

                                time:
                                    parsed.time,

                                logo:
                                    channel.logo ||
                                    "",

                                streams: []
                            }
                        );
                    }

                    const matchEntry =
                        siteEntry.matches.get(
                            key
                        );

                    if (
                        !matchEntry.logo &&
                        channel.logo
                    ) {

                        matchEntry.logo =
                            channel.logo;
                    }

                    const streamId =
                        crypto
                            .createHash("sha1")
                            .update(channel.url)
                            .digest("hex");

                    matchEntry.streams.push({

                        id:
                            streamId,

                        name:
                            parsed.blv ||
                            "Luồng chính",

                        url:
                            channel.url,

                        headers:
                            channel.headers ||
                            {},

                        clearKeys:
                            channel.clearKeys ||
                            {}
                    });
                }

                const sites =
                    Array.from(
                        siteMap.values()
                    ).map(site => ({

                        name:
                            site.name,

                        logo:
                            site.logo,

                        matches:
                            Array.from(
                                site.matches.values()
                            )
                    }));

                return res.json({

                    ok: true,

                    sites
                });
            }

            // ==================================================
            // FOOTBALL
            // ==================================================

            const map =
                new Map();

            for (
                const channel
                of channels
            ) {

                const groupName =
                    channel.group ||
                    "Khác";

                if (groupName.trim().toUpperCase() === "INFO") {
                    continue;
                }

                if (
                    !map.has(
                        groupName
                    )
                ) {

                    map.set(
                        groupName,
                        {

                            key:
                                crypto
                                    .createHash(
                                        "md5"
                                    )
                                    .update(
                                        groupName
                                    )
                                    .digest(
                                        "hex"
                                    ),

                            name:
                                groupName,

                            startAt:
                                Date.now(),

                            channels: []
                        }
                    );
                }

                const streamId =
                    crypto
                        .createHash(
                            "sha1"
                        )
                        .update(
                            channel.url
                        )
                        .digest(
                            "hex"
                        );

                map
                    .get(
                        groupName
                    )
                    .channels
                    .push({

                        name:
                            channel.name,

                        commentator:
                            channel.name,

                        source:
                            channel.group ||
                            "Nguồn khác",

                        sourceLogo:
                            channel.logo ||
                            "",

                        streamId,

                        url:
                            channel.url,

                        headers:
                            channel.headers ||
                            {},

                        clearKeys:
                            channel.clearKeys ||
                            {}
                    });
            }

            return res.json({

                ok: true,

                groups:
                    Array.from(
                        map.values()
                    )
            });

        } catch (error) {

            console.error(
                "CHANNEL API ERROR:",
                error
            );

            return res.status(500).json({

                ok: false,

                error:
                    error.message
            });
        }
    }
);

// ======================================================
// API: FOOTBALL STREAM
// ======================================================

app.get(
    "/api/football/stream/:id",
    async (req, res) => {

        try {

            const id =
                String(
                    req.params.id
                );

            const channels =
                await loadPlaylist(
                    "football"
                );

            let channel = null;

            for (
                const item
                of channels
            ) {

                const streamId =
                    crypto
                        .createHash(
                            "sha1"
                        )
                        .update(
                            item.url
                        )
                        .digest(
                            "hex"
                        );

                if (
                    streamId === id
                ) {

                    channel =
                        item;

                    break;
                }
            }

            if (!channel) {

                return res.status(404).json({

                    ok: false,

                    error:
                        "Không tìm thấy stream"
                });
            }

            const detected =
                await detectStreamType(
                    channel.url,
                    {
                        ...FOOTBALL_HEADERS,
                        ...channel.headers
                    }
                );
            if (detected.kind === "upstream_error") {
                return res.status(502).json({
                    ok: false,
                    error: "Nguồn stream trả HTTP " + detected.status,
                    upstreamStatus: detected.status,
                    requestedUrl: channel.url,
                    errorUrl: detected.errorUrl
                });
            }
            let clearKeys =
                channel.clearKeys ||
                {};

            // ==================================================
            // FIX CLEARKEY CHO FOOTBALL DASH
            // ==================================================

            if (
                detected.kind === "dash" &&
                Object.keys(clearKeys).length > 0
            ) {

                clearKeys =
                    await fixClearKeysForMPD(
                        detected.finalUrl ||
                        channel.url,

                        clearKeys,

                        {
                            ...FOOTBALL_HEADERS,
                            ...channel.headers
                        }
                    );
            }

            if (detected.kind === "dash") {
                const check = await verifyDashKeys(
                    detected.finalUrl || channel.url,
                    clearKeys,
                    {
                        ...FOOTBALL_HEADERS,
                        ...channel.headers
                    }
                );
                if (!check.ok) {
                    return res.status(502).json({
                        ok: false,
                        error: "Kenh nay chua co key giai ma cho KID " + (check.missing || []).join(", "),
                        kind: "missing_key",
                        missingKids: check.missing,
                        haveKids: Object.keys(clearKeys)
                    });
                }
            }

            // ===================================================
            // RESPONSE
            // ===================================================

            const streamHeaders =
                {
                    ...FOOTBALL_HEADERS,
                    ...channel.headers
                };

            return res.json({
                ok: true,
                finalUrl:
                    detected.finalUrl ||
                    channel.url,
                playUrl:
                    detected.kind === "video" ||
                    detected.kind === "hls" ||
                    (
                        detected.kind === "dash" &&
                        String(
                            streamHeaders["User-Agent"] ||
                            streamHeaders["user-agent"] ||
                            ""
                        ).toLowerCase().includes("dalvik")
                    )
                        ? proxyUrl(
                            detected.finalUrl ||
                            channel.url,
                            detected.kind === "dash"
                                ? "dalvik"
                                : ""
                        )
                        : detected.finalUrl ||
                          channel.url,
                kind:
                    detected.kind,
                contentType:
                    detected.contentType,
                clearKeys,
                headers:
                    streamHeaders
            });

        } catch (error) {

            console.error(
                "==========================================\n"
            );

            console.error(
                "FOOTBALL STREAM ERROR:\n",
                error
            );

            console.error(
                "==========================================\n"
            );

            return res.status(502).json({
                ok: false,
                error:
                    error.message ||
                    String(error)
            });
        }
    }
);

// ======================================================
// API: STREAM PROXY
// ======================================================

app.get(
    "/api/proxy",
    async (req, res) => {
        const target = normalizeUrl(req.query.url);
        const profile = normalizeUrl(req.query.profile);
        // Referer nguồn (truyền từ #EXTVLCOPT của playlist, ví dụ
        // Chuối Chiên cần Referer https://live.chuoichien.tv/).
        const referer = normalizeUrl(req.query.ref);

        const needsDalvik =
            /tv360|vmttv|dpdns|mytvnet/i.test(target);

        const profileHeaders =
            profile === "dalvik" || needsDalvik
                ? {
                    "User-Agent": "Dalvik/2.1.0"
                }
                : {};

        if (!/^https?:\/\//i.test(target)) {
            return res.status(400).json({
                ok: false,
                error: "URL stream không hợp lệ"
            });
        }

        // Chỉ gắn Referer/Origin livesport khi target thuộc livesport
        // (ép Referer lên domain khác có thể khiến nguồn từ chối request).

        const isLivesportTarget =
            /(^|\.)livesport\.s\.gy$/i.test(new URL(target).hostname) ||
            /livesport/i.test(target);

        // Uu tien referer do client truyen (tu playlist); neu khong co
        // thi giu mac dinh livesport cho target livesport.
        const sourceReferer =
            referer ||
            (isLivesportTarget
                ? "https://livesport.s.gy/"
                : "");

        let sourceOrigin = "";

        if (sourceReferer) {
            try {
                sourceOrigin = new URL(sourceReferer).origin;
            } catch {}
        }

        try {
            const upstream = await fetchResponse(
                target,
                {
                    ...FOOTBALL_HEADERS,
                    ...profileHeaders,
                    ...(req.headers.range
                        ? { Range: req.headers.range }
                        : {}),
                    ...(sourceReferer
                        ? {
                            Referer: sourceReferer,
                            ...(sourceOrigin
                                ? { Origin: sourceOrigin }
                                : {})
                        }
                        : {})
                },
                // Proxy chi phuc vu segment video cua CDN ben thu ba;
                // cho phep bo qua verify de vuot cert het han (nguon free).
                true
            );

            const contentType = String(
                upstream.headers.get("content-type") || ""
            ).toLowerCase();

            if (
                contentType.includes("application/dash+xml") ||
                /\.mpd(?:\?|$)/i.test(upstream.url || target)
            ) {
                const manifest = await upstream.text();

                res.status(upstream.status);
                res.setHeader(
                    "Content-Type",
                    "application/dash+xml"
                );
                res.setHeader(
                    "Access-Control-Allow-Origin",
                    "*"
                );
                res.setHeader(
                    "Cache-Control",
                    "no-store"
                );

                // TV360 khai ContentProtection nhung segment thuc te
                // la clear -> go DRM de tranh loi Shaka 3016.
                let targetHost = "";

                try {
                    targetHost = new URL(target).hostname;
                } catch {}

                const stripDrm =
                    /(^|\.)tv360\.vn$/i.test(targetHost) ||
                    /vmttv|dpdns/i.test(targetHost);

                return res.send(
                    rewriteDashManifest(
                        manifest,
                        upstream.url || target,
                        profile,
                        referer,
                        stripDrm
                    )
                );
            }

            if (
                contentType.includes("mpegurl") ||
                /\.m3u8(?:\?|$)/i.test(upstream.url || target)
            ) {
                const playlist = await upstream.text();

                res.status(upstream.status);
                res.setHeader(
                    "Content-Type",
                    "application/vnd.apple.mpegurl"
                );
                res.setHeader(
                    "Access-Control-Allow-Origin",
                    "*"
                );
                res.setHeader(
                    "Cache-Control",
                    "no-store"
                );

                return res.send(
                    rewriteHlsPlaylist(
                        playlist,
                        upstream.url || target,
                        referer
                    )
                );
            }

            res.status(upstream.status);
            res.setHeader("Access-Control-Allow-Origin", "*");

            for (const header of [
                "content-type",
                "content-length",
                "content-range",
                "accept-ranges",
                "cache-control",
                "etag",
                "last-modified"
            ]) {
                const value = upstream.headers.get(header);

                if (value) {
                    res.setHeader(header, value);
                }
            }

            if (!upstream.body) {
                return res.end();
            }

            // Stream truc tiep, khong buffer -> tiet kiem RAM tren Railway free.
            // Gioi han so byte de mot request loi khong dot het bang thong.
            const source = Readable.fromWeb(upstream.body);
            let sent = 0;
            let aborted = false;

            // CHI destroy(source): Readable.fromWeb da "lock" upstream.body,
            // goi them upstream.body.cancel() se nem
            // "Invalid state: ReadableStream is locked" (unhandled rejection).
            const abortUpstream = () => {
                if (aborted) return;
                aborted = true;
                try { source.destroy(); } catch {}
            };

            source.on("data", chunk => {
                sent += chunk.length;
                if (sent > MAX_PROXY_BYTES) {
                    abortUpstream();
                    try { res.end(); } catch {}
                }
            });

            source.on("error", () => {
                abortUpstream();
                try { res.end(); } catch {}
            });

            // Client bam Stop / doi kenh -> dong ket noi nguon ngay,
            // neu khong Railway se tinh phi bang thong cho phan khong ai xem.
            res.on("close", abortUpstream);

            source.pipe(res);
        } catch (error) {
            console.error("PROXY ERROR:", error.message);
            res.status(502).json({
                ok: false,
                error: "Không tải được stream nguồn"
            });
        }
    }
);

// ======================================================
// API: FOOTBALL HLS
// ======================================================

app.get(
    "/api/football/hls/:id",
    async (req, res) => {

        try {

            const id =
                String(
                    req.params.id
                );

            const channels =
                await loadPlaylist(
                    "football"
                );

            let channel = null;

            for (
                const item
                of channels
            ) {

                const streamId =
                    crypto
                        .createHash(
                            "sha1"
                        )
                        .update(
                            item.url
                        )
                        .digest(
                            "hex"
                        );

                if (
                    streamId === id
                ) {

                    channel =
                        item;

                    break;
                }
            }

            if (!channel) {

                return res.status(404).json({

                    ok: false,

                    error:
                        "Không tìm thấy stream"
                });
            }

            const detected =
                await detectStreamType(
                    channel.url,
                    {
                        ...FOOTBALL_HEADERS,
                        ...channel.headers
                    }
                );

            let clearKeys =
                channel.clearKeys ||
                {};

            if (
                detected.kind === "dash" &&
                Object.keys(clearKeys).length > 0
            ) {

                clearKeys =
                    await fixClearKeysForMPD(
                        detected.finalUrl ||
                        channel.url,

                        clearKeys,

                        channel.headers ||
                        {}
                    );
            }

            return res.json({

                ok: true,

                url:
                    detected.finalUrl ||
                    channel.url,

                kind:
                    detected.kind,

                clearKeys,

                headers:
                    channel.headers ||
                    {}
            });

        } catch (error) {

            console.error(
                "FOOTBALL HLS ERROR:",
                error
            );

            return res.status(500).json({

                ok: false,

                error:
                    error.message
            });
        }
    }
);

// ======================================================
// API: RESOLVE TV
// ======================================================

app.get(
    "/api/resolve",
    async (req, res) => {

        try {

            const url =
                normalizeUrl(
                    req.query.url
                );

            if (!url) {

                return res.status(400).json({

                    ok: false,

                    error:
                        "Thiếu url"
                });
            }

            console.log(
                "=========================================="
            );

            console.log(
                "TV RESOLVE REQUEST"
            );

            console.log(
                "URL:",
                url
            );

            // ==================================================
            // Tìm channel trong playlist
            // ==================================================

            let channel = null;

            try {

                channel =
                    await findChannelByUrl(
                        url
                    );

            } catch (e) {

                console.warn(
                    "Channel lookup:",
                    e.message
                );
            }

            const headers =
                channel?.headers ||
                {};

            let clearKeys =
                channel?.clearKeys ||
                {};

            console.log(
                "CHANNEL FOUND:",
                !!channel
            );

            console.log(
                "CHANNEL NAME:",
                channel?.name ||
                "Không có"
            );

            console.log(
                "CHANNEL HEADERS:",
                headers
            );

            console.log(
                "PLAYLIST CLEARKEYS:",
                clearKeys
            );

            // ==================================================
            // Detect stream
            // ==================================================

            const detected =
                await detectStreamType(
                    url,
                    headers
                );

            const finalUrl =
                detected.finalUrl ||
                url;

            if (
                detected.kind === "network_error" ||
                detected.kind === "upstream_error" ||
                detected.kind === "unknown"
            ) {
                return res.status(502).json({
                    ok: false,
                    error:
                        "Nguồn TV không trả về luồng phát hợp lệ",
                    kind: detected.kind,
                    upstreamStatus: detected.status,
                    requestedUrl: url,
                    finalUrl
                });
            }

            console.log(
                "TV DETECT:",
                detected.kind
            );

            console.log(
                "TV FINAL URL:",
                finalUrl
            );

            console.log(
                "TV CONTENT TYPE:",
                detected.contentType
            );

            console.log(
                "TV CLEARKEY COUNT BEFORE FIX:",
                Object.keys(
                    clearKeys
                ).length
            );

            // ==================================================
            // FIX CLEARKEY THEO MPD
            // ==================================================

            if (
                detected.kind === "dash" &&
                Object.keys(clearKeys).length > 0
            ) {

                clearKeys =
                    await fixClearKeysForMPD(
                        finalUrl,

                        clearKeys,

                        // DASH thường cần FOOTBALL_HEADERS-like UA
                        // để lấy được bản MPD đúng; merge với
                        // header của playlist nếu có.
                        {
                            ...FOOTBALL_HEADERS,
                            ...headers
                        }
                    );

                console.log(
                    "TV FIXED CLEARKEYS:",
                    clearKeys
                );

            } else {

                if (
                    detected.kind === "dash"
                ) {

                    console.log(
                        "TV DASH nhưng playlist không có ClearKey"
                    );
                }
            }

            console.log(
                "TV CLEARKEY COUNT AFTER FIX:",
                Object.keys(
                    clearKeys
                ).length
            );

            // ==================================================
            // RESPONSE
            // ==================================================

            // Referer nguồn để proxy gửi kèm (Chuối Chiên, Sao Kê...
            // đều yêu cầu Referer riêng nếu không sẽ 403).
            const sourceReferer =
                headers.Referer ||
                headers.referer ||
                "";

            return res.json({

                ok: true,

                finalUrl,

                playUrl:
                    detected.kind === "video" ||
                    detected.kind === "hls" ||
                    (
                        detected.kind === "dash" &&
                        String(
                            headers["User-Agent"] ||
                            headers["user-agent"] ||
                            ""
                        ).toLowerCase().includes("dalvik")
                    )
                        ? proxyUrl(
                            finalUrl,
                            detected.kind === "dash"
                                ? "dalvik"
                                : "",
                            sourceReferer
                        )
                        : finalUrl,

                kind:
                    detected.kind,

                contentType:
                    detected.contentType,

                clearKeys,

                headers
            });

        } catch (error) {

            console.error(
                "=========================================="
            );

            console.error(
                "TV RESOLVE ERROR:",
                error
            );

            return res.status(500).json({

                ok: false,

                error:
                    error.message ||
                    String(error)
            });
        }
    }
);

// ======================================================
// HEALTH CHECK
// ======================================================
app.get("/debug", async (req, res) => {

    // Endpoint chan doan: tat mac dinh, chi bat khi DEBUG=1
    // de khong lo thong tin va khong ton bang thong tren Railway.
    if (!DEBUG) {
        return res.status(404).json({ ok: false, error: "Not found" });
    }

    try {

        const r = await fetchText(
            "https://livesport.io.vn/ok/iptv.php?id=skyepl"
        );

        res.json({
            finalUrl: r.url,
            status: r.status,
            contentType: r.headers.get("content-type"),
            text: r.text.substring(0, 1000)
        });

    } catch (e) {

        res.json({
            error: e.message
        });
    }
});
app.get(
    "/api/health",
    (req, res) => {

        res.json({

            ok: true,

            server:
                "TV360 WEB PLAYER",

            time:
                new Date().toISOString()
        });
    }
);

// ======================================================
// STATIC
// ======================================================

app.use(
    express.static(
        path.join(
            __dirname,
            "public"
        ),
        {
            // De route "/" (co gzip) xu ly index.html thay vi static.
            index: false,
            // index.html luon lay ban moi, asset khac cache 1 ngay
            // -> giam so request len Railway free.
            setHeaders(res, filePath) {
                if (/index\.html$/i.test(filePath)) {
                    res.setHeader("Cache-Control", "no-cache");
                } else {
                    res.setHeader(
                        "Cache-Control",
                        "public, max-age=86400"
                    );
                }
            }
        }
    )
);

// ======================================================
// ROOT
// ======================================================
// index.html duoc doc 1 lan va gzip san trong bo nho
// (89KB -> ~15KB, tiet kiem bang thong Railway free + nhanh hon).

const INDEX_HTML_PATH =
    path.join(
        __dirname,
        "public",
        "index.html"
    );

let indexHtmlCache = null;

function getIndexHtml() {

    if (indexHtmlCache) {
        return indexHtmlCache;
    }

    try {

        const raw = require("fs").readFileSync(
            INDEX_HTML_PATH
        );

        indexHtmlCache = {

            raw,

            gzip:
                zlib.gzipSync(raw)
        };

    } catch (error) {

        console.error(
            "DOC INDEX.HTML LOI:",
            error.message
        );

        return null;
    }

    return indexHtmlCache;
}

app.get(
    "/",
    (req, res) => {

        const cached =
            getIndexHtml();

        // index.html doi khi sua -> cho phep revalidate bang ETag.
        res.setHeader(
            "Cache-Control",
            "no-cache"
        );

        res.setHeader(
            "Content-Type",
            "text/html; charset=utf-8"
        );

        if (!cached) {
            return res
                .status(500)
                .send("Không đọc được index.html");
        }

        const accept =
            String(
                req.headers["accept-encoding"] ||
                ""
            );

        if (/gzip/i.test(accept)) {

            res.setHeader(
                "Content-Encoding",
                "gzip"
            );

            res.setHeader(
                "Vary",
                "Accept-Encoding"
            );

            return res.send(
                cached.gzip
            );
        }

        return res.send(
            cached.raw
        );
    }
);

// ======================================================
// ERROR HANDLER
// ======================================================

app.use(
    (
        err,
        req,
        res,
        next
    ) => {

        console.error(
            "SERVER ERROR:",
            err
        );

        if (res.headersSent) {
            return next(err);
        }

        res.status(500).json({

            ok: false,

            error:
                err.message ||
                "Server error"
        });
    }
);

// ======================================================
// START
// ======================================================

const server = app.listen(
    PORT,
    () => {

        console.log(
            "=========================================="
        );

        console.log(
            "TV360 WEB PLAYER"
        );

        console.log(
            "SERVER RUNNING:"
        );

        console.log(
            `http://localhost:${PORT}`
        );

        console.log(
            "=========================================="
        );
    }
);

// Giữ kết nối sống lâu hơn -> giảm handshake cho luồng video liên tục.
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.on("error", error => {
    console.error("SERVER LISTEN ERROR:", error.message);
});

// Railway free: process phai tu phuc hoi, khong duoc chet vi 1 promise loi.
process.on("unhandledRejection", reason => {
    console.error(
        "UNHANDLED REJECTION:",
        reason && reason.message ? reason.message : reason
    );
});

process.on("uncaughtException", error => {
    console.error("UNCAUGHT EXCEPTION:", error.message);
});

// Railway gui SIGTERM khi deploy/restart -> dong server sach se.
for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
        console.log(`Nhan ${signal}, dang tat server...`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 8000).unref();
    });
}