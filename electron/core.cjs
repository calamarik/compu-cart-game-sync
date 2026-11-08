// Compu-Cart core: hotplug detection, integrity check, savegame sync, launch orchestration.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");

const MANIFEST = "compucart.json";

/** 1. Hotplug: polls Windows drive letters (D:..Z:) for a cartridge manifest. */
class HotplugWatcher extends EventEmitter {
  constructor(intervalMs = 1500) {
    super();
    this.intervalMs = intervalMs;
    this.known = new Set();
  }
  start() {
    this.timer = setInterval(() => this.scan(), this.intervalMs);
    this.scan();
  }
  stop() {
    clearInterval(this.timer);
  }
  scan() {
    const now = new Set();
    for (const l of "DEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${l}:\\`;
      if (fs.existsSync(path.join(root, MANIFEST))) now.add(root);
    }
    for (const r of now) if (!this.known.has(r)) this.emit("inserted", r);
    for (const r of this.known) if (!now.has(r)) this.emit("removed", r);
    this.known = now;
  }
}

async function readManifest(root) {
  const m = JSON.parse(await fsp.readFile(path.join(root, MANIFEST), "utf8"));
  if (!m.id || !m.title || !m.executable) throw new Error("Manifeste invalide (id/title/executable requis)");
  return { saveDir: "saves", checksums: {}, intro: {}, ...m };
}

function sha256(file) {
  return new Promise((res, rej) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });
}

/** Integrity: every file listed in manifest.checksums must match its SHA-256. */
async function verifyIntegrity(root, manifest) {
  const results = [];
  for (const [rel, expected] of Object.entries(manifest.checksums)) {
    const file = path.join(root, rel);
    let actual = null;
    try { actual = await sha256(file); } catch {}
    results.push({ file: rel, ok: actual === String(expected).toLowerCase(), expected, actual });
  }
  return { ok: results.every((r) => r.ok), results };
}

async function listFiles(dir, base = dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, await listFiles(full, base));
    else out[path.relative(base, full)] = (await fsp.stat(full)).mtimeMs;
  }
  return out;
}

/** Newest wins; 2s tolerance absorbs FAT32 timestamp granularity. */
function planSync(local, cart, toleranceMs = 2000) {
  const plan = [];
  for (const f of new Set([...Object.keys(local), ...Object.keys(cart)])) {
    const l = local[f], c = cart[f];
    if (l === undefined) plan.push({ file: f, action: "pull" });
    else if (c === undefined) plan.push({ file: f, action: "push" });
    else if (c - l > toleranceMs) plan.push({ file: f, action: "pull" });
    else if (l - c > toleranceMs) plan.push({ file: f, action: "push" });
    else plan.push({ file: f, action: "skip" });
  }
  return plan;
}

/** Safe copy: write to temp, verify hash, atomic rename, keep .bak of previous. */
async function safeCopy(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const tmp = dst + ".cctmp";
  await fsp.copyFile(src, tmp);
  if ((await sha256(src)) !== (await sha256(tmp))) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`Vérification échouée: ${src}`);
  }
  const st = await fsp.stat(src);
  await fsp.utimes(tmp, st.atime, st.mtime);
  if (fs.existsSync(dst)) await fsp.copyFile(dst, dst + ".bak");
  await fsp.rename(tmp, dst);
}

/** 2. Savegame Sync Engine (bi-directional). */
async function syncSaves(root, manifest, appDataDir) {
  const localDir = path.join(appDataDir, "CompuCart", "saves", manifest.id);
  const cartDir = path.join(root, manifest.saveDir);
  await fsp.mkdir(localDir, { recursive: true });
  await fsp.mkdir(cartDir, { recursive: true });
  const plan = planSync(await listFiles(localDir), await listFiles(cartDir));
  for (const p of plan) {
    if (p.action === "pull") await safeCopy(path.join(cartDir, p.file), path.join(localDir, p.file));
    if (p.action === "push") await safeCopy(path.join(localDir, p.file), path.join(cartDir, p.file));
  }
  return { localDir, cartDir, plan };
}

/** 3. Orchestrator: launches the game; resolves when it exits (then a final push sync). */
function launchGame(root, manifest) {
  return new Promise((res, rej) => {
    const exe = path.join(root, manifest.executable);
    if (!fs.existsSync(exe)) return rej(new Error(`Exécutable introuvable: ${exe}`));
    const child = spawn(exe, manifest.args || [], { cwd: path.dirname(exe), detached: false });
    child.on("error", rej);
    child.on("exit", (code) => res(code));
  });
}

module.exports = { HotplugWatcher, readManifest, verifyIntegrity, planSync, syncSaves, launchGame, safeCopy };
