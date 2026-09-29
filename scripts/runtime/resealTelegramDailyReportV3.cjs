const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = process.cwd();
const rel = "lib/telegram/dailyReport.ts";
const digest = (p) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const active = path.join(root, rel);
for (const ver of ["v5", "v6"]) {
  const snap = path.join(root, `financial-core/${ver}/snapshot`, rel);
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  fs.copyFileSync(active, snap);
  console.log("synced", ver, digest(active));
}

function updateManifest(ver) {
  const mp = path.join(root, `financial-core/${ver}/manifest.json`);
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  let changed = 0;
  for (const row of m.protectedFiles || []) {
    if (row.path !== rel) continue;
    const a = digest(path.join(root, row.path));
    const s = digest(path.join(root, `financial-core/${ver}/snapshot`, row.path));
    console.log(`manifest ${ver} ${row.path}`);
    console.log(`  sha ${row.sha256} -> ${a}`);
    console.log(`  snap ${row.snapshotSha256} -> ${s}`);
    row.sha256 = a;
    row.snapshotSha256 = s;
    changed++;
  }
  fs.writeFileSync(mp, JSON.stringify(m, null, 2) + "\n");
  console.log(`manifest ${ver} changedRows=${changed}`);
}

updateManifest("v5");
updateManifest("v6");
