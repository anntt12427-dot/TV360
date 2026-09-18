// Script kiểm tra endpoint health của server cục bộ.
// Chạy: node test-health.js
const PORT = Number(process.env.PORT) || 3000;
const url = `http://localhost:${PORT}/api/health`;

async function main() {
    console.log("node ok");
    try {
        const res = await fetch(url);
        const text = await res.text();
        console.log("health:", text);
        process.exit(res.ok ? 0 : 1);
    } catch (error) {
        console.log("health fail:" + error.message);
        process.exit(1);
    }
}

main();
