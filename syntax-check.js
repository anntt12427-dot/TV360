// Kiem tra cu phap server.js + cac <script> inline trong index.html
const fs = require("fs");
const { execSync } = require("child_process");

try {
    execSync("node --check server.js", { stdio: "pipe" });
    console.log("server.js: OK");
} catch (e) {
    console.log("server.js: LOI\n" + e.stderr.toString());
    process.exit(1);
}

const html = fs.readFileSync("public/index.html", "utf8");
const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, i = 0, ok = true;
while ((m = scriptRe.exec(html)) !== null) {
    i++;
    const tmp = ".tmp-script-" + i + ".js";
    fs.writeFileSync(tmp, m[1]);
    try {
        execSync(`node --check ${tmp}`, { stdio: "pipe" });
        console.log(`script #${i} (${m[1].length} chars): OK`);
    } catch (e) {
        ok = false;
        console.log(`script #${i}: LOI\n` + e.stderr.toString().slice(0, 2000));
    }
    fs.unlinkSync(tmp);
}
console.log(ok ? "TAT CA OK" : "CO LOI");
