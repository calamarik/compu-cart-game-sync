// Compu-Cart core: hotplug detection, integrity check, savegame sync, launch orchestration.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { EventEmitter } = require("events");

const MANIFEST = "compucart.json";

const WM_DEVICECHANGE = 0x0219;
const DBT = { 0x0007: "change", 0x8000: "arrival", 0x8004: "removal" };
/** Maps a WM_DEVICECHANGE wParam to an event kind (null = ignore). */
const deviceEventKind = (wParam) => DBT[wParam] || null;

/**
 * 1. Hotplug: event-driven. Windows broadcasts WM_DEVICECHANGE when a volume
 * arrives/leaves; notify() then scans drive letters a few times (mounting lags
 * the event). No periodic polling unless pollMs is set (non-Windows dev only).
 * Ejected roots are suppressed until a new arrival, so the scan never touches
 * (and remounts) a dismounted volume.
 */
class HotplugWatcher extends EventEmitter {
  constructor({ pollMs = 0, letters = "DEFGHIJKLMNOPQRSTUVWXYZ", exists, now = Date.now, rescanDelays = [300, 1500, 4000], startupDelays = [2000, 6000, 15000] } = {}) {
    super();
    this.pollMs = pollMs;
    this.letters = letters;
    this.exists = exists || ((root) => fs.existsSync(path.join(root, MANIFEST)));
    this.now = now;
    this.rescanDelays = rescanDelays;
    this.startupDelays = startupDelays;
    this.known = new Set();
    this.suppressed = new Map();
    this.pending = [];
    this.startupTimers = [];
  }
  /**
   * Forced detection at launch: scans now, then a few more times (Windows may
   * still be mounting USB drives at logon). Cartridges found this way are
   * reported with reason "startup" so the game is not launched automatically.
   */
  start() {
    if (this.pollMs) this.timer = setInterval(() => this.scan("device"), this.pollMs);
    this.scan("startup");
    this.startupTimers = this.startupDelays.map((ms) => setTimeout(() => this.scan("startup"), ms));
  }
  stop() {
    clearInterval(this.timer);
    [...this.pending, ...this.startupTimers].forEach(clearTimeout);
    this.pending = [];
    this.startupTimers = [];
  }
  /** A Windows device event: the drive was just plugged (reason "device"). */
  notify(kind) {
    if (kind === "arrival") for (const [root, at] of this.suppressed) if (this.now() - at > 2000) this.suppressed.delete(root);
    this.pending.forEach(clearTimeout);
    this.pending = this.rescanDelays.map((ms) => setTimeout(() => this.scan("device"), ms));
  }
  /** One-off scan outside a plug event (resume from sleep, "Rechercher" button). */
  rescan(reason = "manual") {
    this.scan(reason);
  }
  /** Forget a root after a safe eject; it is ignored until a new arrival event. */
  suppress(root) {
    this.known.delete(root);
    this.suppressed.set(root, this.now());
  }
  scan(reason = "device") {
    const now = new Set();
    for (const l of this.letters) {
      const root = `${l}:\\`;
      if (this.suppressed.has(root)) continue;
      if (this.exists(root)) now.add(root);
    }
    for (const r of now) if (!this.known.has(r)) this.emit("inserted", r, reason);
    for (const r of this.known) if (!now.has(r)) this.emit("removed", r);
    this.known = now;
  }
}

async function readManifest(root) {
  const m = JSON.parse(await fsp.readFile(path.join(root, MANIFEST), "utf8"));
  if (!/^[a-zA-Z0-9_-]+$/.test(m.id || "") || typeof m.title !== "string" || !m.title || typeof m.executable !== "string") throw new Error("Manifeste invalide (id/title/executable requis)");
  const manifest = { saveDir: "saves", intro: {}, ...m };
  if (!manifest.checksums || typeof manifest.checksums !== "object" || Array.isArray(manifest.checksums)) throw new Error("Empreintes SHA-256 requises");
  if (!manifest.checksums[manifest.executable]) throw new Error("Empreinte SHA-256 de l'exécutable requise");
  if (manifest.args !== undefined && (!Array.isArray(manifest.args) || manifest.args.some((arg) => typeof arg !== "string"))) throw new Error("Arguments invalides");
  for (const rel of [manifest.executable, manifest.saveDir, manifest.intro?.image, manifest.intro?.audio, ...Object.keys(manifest.checksums)]) {
    if (rel !== undefined) await validatePath(root, rel);
  }
  for (const hash of Object.values(manifest.checksums)) if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error("Empreinte SHA-256 invalide");
  return manifest;
}

async function validatePath(root, rel) {
  if (typeof rel !== "string" || !rel || rel.includes(":") || path.win32.isAbsolute(rel) || rel.split(/[\\/]/).some((part) => part === "..")) throw new Error("Chemin de cartouche invalide");
  const target = path.resolve(root, rel);
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Chemin hors cartouche");
  let cursor = path.resolve(root);
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    try { if ((await fsp.lstat(cursor)).isSymbolicLink()) throw new Error("Liens de fichiers interdits sur la cartouche"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return target;
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
    if (e.isSymbolicLink()) throw new Error("Liens de fichiers interdits dans les sauvegardes");
    if (e.name.endsWith(".bak") || e.name.endsWith(".cctmp")) continue;
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

/** 3. Orchestrator: launches the game; resolves when it exits (then a final push sync). onSpawn gets the child process right after the start. */
function launchGame(root, manifest, onSpawn) {
  return new Promise((res, rej) => {
    const exe = path.join(root, manifest.executable);
    if (!fs.existsSync(exe)) return rej(new Error(`Exécutable introuvable: ${exe}`));
    const child = spawn(exe, manifest.args || [], { cwd: path.dirname(exe), detached: false });
    child.on("error", rej);
    child.on("exit", (code) => res(code));
    if (onSpawn) onSpawn(child);
  });
}

/** PowerShell loop: prints FOUND as soon as a process started from the cartridge owns a visible window. */
function gameWindowScript(root) {
  const prefix = String(root).replace(/[\\/]+$/, "").replace(/'/g, "''") + "\\";
  return `$p='${prefix}';for(;;){if(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -and $_.Path.StartsWith($p, [StringComparison]::OrdinalIgnoreCase) }){'FOUND';break};Start-Sleep -Milliseconds 400}`;
}

/**
 * Resolves "window" when the game shows a window, "timeout" after timeoutMs (heavy games, launchers that start the game from elsewhere),
 * "cancelled" when cancel() is called (game exited, cartridge removed). Never rejects: a detection failure just means "timeout".
 * Without Windows (dev, tests) it resolves "timeout" right away unless a spawn function is injected.
 */
function waitForGameWindow(root, { timeoutMs = 120000, spawnFn = spawn, platform = process.platform } = {}) {
  let cancel = () => {};
  const done = new Promise((res) => {
    if (platform !== "win32" && spawnFn === spawn) return res("timeout");
    let child = null, finished = false;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { child && child.kill(); } catch {}
      res(r);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    cancel = () => finish("cancelled");
    try {
      const encoded = Buffer.from(gameWindowScript(root), "utf16le").toString("base64");
      child = spawnFn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true });
      let out = "";
      child.stdout.on("data", (d) => { out += d; if (out.includes("FOUND")) finish("window"); });
      child.on("error", () => finish("timeout"));
      child.on("exit", () => finish(out.includes("FOUND") ? "window" : "timeout"));
    } catch { finish("timeout"); }
  });
  return { done, cancel: () => cancel() };
}

/** Milliseconds left before the intro may end: it is never cut shorter than minMs, so a fast game does not flash the intro. */
const introRemaining = (startedAt, now, minMs = 3200) => Math.max(0, startedAt + minMs - now);

/** Only a cartridge plugged in while Compu-Cart runs starts its game by itself. */
const autoPlays = (reason, autoLaunch = true) => reason === "device" && autoLaunch !== false;

/** After verification and sync: play the intro and launch, or stop on "ready" and wait for the Play button. */
const nextStateAfterSync = (reason, autoLaunch = true) => (autoPlays(reason, autoLaunch) ? "intro" : "ready");

/**
 * Latest console state, kept in the main process. The window may open (or
 * reload) after a cartridge was already detected, so it asks for this snapshot
 * instead of relying on having been listening at that exact moment.
 * Logs are newest first, like in the window.
 */
class StateStore {
  constructor(maxLogs = 60) {
    this.maxLogs = maxLogs;
    this.cart = { state: "empty" };
    this.integrity = null;
    this.sync = null;
    this.logs = [];
  }
  setCart(cart) { this.cart = cart; }
  setIntegrity(integrity) { this.integrity = integrity; }
  setSync(sync) { this.sync = sync; }
  addLog(entry) { this.logs = [entry, ...this.logs].slice(0, this.maxLogs); }
  snapshot() { return { cart: this.cart, integrity: this.integrity, sync: this.sync, logs: this.logs }; }
}

/** "E:\\" -> "E". Only D..Z are cartridge letters. */
function driveLetter(root) {
  const m = /^([D-Z]):\\?$/i.exec(String(root || ""));
  if (!m) throw new Error(`Lecteur invalide: ${root}`);
  return m[1].toUpperCase();
}

const VETO_REASONS = { 1: "erreur inconnue", 2: "pilote Windows", 3: "un service l'utilise", 4: "Windows refuse le retrait", 5: "un pilote le bloque", 6: "un programme l'utilise", 7: "périphérique non retirable", 8: "fichiers encore ouverts", 9: "périphérique non retirable", 10: "pilote en cours d'arrêt", 11: "Windows refuse le retrait", 12: "pilote non désactivable" };

/** Turns the eject script's output line into a result. */
function parseEjectOutput(stdout) {
  const line = String(stdout || "").trim().split(/\r?\n/).pop() || "";
  if (line === "OK") return { status: "removed" };
  if (line === "BUSY") return { status: "busy", detail: "Un programme utilise encore la cartouche (fichier ouvert)." };
  const veto = /^VETO:(\d+):(.*)$/.exec(line);
  if (veto) return { status: "vetoed", detail: `Windows n'a pas déconnecté la cartouche (${VETO_REASONS[veto[1]] || "refus"}${veto[2] ? ` : ${veto[2]}` : ""}). Ne la retirez pas : réessayez ou utilisez « Retirer le périphérique en toute sécurité ».` };
  if (line.startsWith("ERR:")) return { status: "error", detail: line.slice(4) };
  return { status: "error", detail: "Réponse inattendue de l'éjection Windows." };
}

/** Builds the PowerShell invocation; the script is passed encoded so execution policy for files does not apply. */
function ejectCommand(root, script) {
  const letter = driveLetter(root);
  const encoded = Buffer.from(`$Lettre = '${letter}'\n${script}`, "utf16le").toString("base64");
  return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded] };
}

/** Safe eject: flush + lock + dismount the volume, then Windows device eject. */
function ejectDrive(root, { spawnImpl = spawn, scriptPath = path.join(__dirname, "eject.ps1"), timeoutMs = 45000 } = {}) {
  return new Promise((res, rej) => {
    let cmd;
    try { cmd = ejectCommand(root, fs.readFileSync(scriptPath, "utf8")); } catch (e) { return rej(e); }
    const child = spawnImpl(cmd.file, cmd.args, { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => { child.kill(); rej(new Error("Éjection trop longue — réessayez")); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); rej(e); });
    child.on("close", () => { clearTimeout(timer); res(parseEjectOutput(out)); });
  });
}

/** Compu-Cart's own options (userData/settings.json). Unknown or unreadable file: defaults. */
const DEFAULT_SETTINGS = { disableAutoplay: false, autoLaunch: true };
function readSettings(file) {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { return { ...DEFAULT_SETTINGS }; }
}
function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

const AUTOPLAY_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\AutoplayHandlers";
const AUTOPLAY_VALUE = "DisableAutoplay";

/** Runs reg.exe and waits: { code, out }. Synchronous so that a restore finishes before the app exits. */
function runReg(args) {
  const r = spawnSync("reg.exe", args, { windowsHide: true, encoding: "utf8", timeout: 8000 });
  return { code: r.status ?? 1, out: `${r.stdout || ""}${r.stderr || ""}` };
}

/**
 * Optional: turns Windows AutoPlay off for this user while Compu-Cart runs, so Windows does not open an
 * Explorer window on the cartridge and take the focus. The previous value is written to a backup file BEFORE
 * anything is changed and put back by restore(); a leftover backup after a crash is restored at the next start.
 * restore() never overwrites a value the user changed by hand in the meantime. Current user only (HKCU), no admin rights.
 * Every method returns { ok, detail } and never throws.
 */
class AutoplayGuard {
  constructor({ backupFile, run = runReg } = {}) {
    this.backupFile = backupFile;
    this.run = run;
  }
  /** Current registry value: { present: false } or { present: true, value: <number> }. */
  read() {
    const r = this.run(["query", AUTOPLAY_KEY, "/v", AUTOPLAY_VALUE]);
    const m = r.code === 0 && new RegExp(`${AUTOPLAY_VALUE}\\s+REG_DWORD\\s+0x([0-9a-fA-F]+)`, "i").exec(r.out);
    return m ? { present: true, value: parseInt(m[1], 16) } : { present: false };
  }
  hasBackup() { return fs.existsSync(this.backupFile); }
  write(value) {
    return this.run(["add", AUTOPLAY_KEY, "/v", AUTOPLAY_VALUE, "/t", "REG_DWORD", "/d", String(value), "/f"]).code === 0;
  }
  enable() {
    try {
      if (!this.hasBackup()) {
        fs.mkdirSync(path.dirname(this.backupFile), { recursive: true });
        fs.writeFileSync(this.backupFile, JSON.stringify(this.read())); // original value saved before touching anything
      }
      if (this.write(1)) return { ok: true, detail: "Exécution automatique de Windows désactivée tant que Compu-Cart tourne." };
      if (!this.hasBackup()) return { ok: false, detail: "Impossible de modifier l'Exécution automatique de Windows." };
      this.restore(); // nothing was changed: drop the backup again
      return { ok: false, detail: "Impossible de modifier l'Exécution automatique de Windows." };
    } catch (e) {
      return { ok: false, detail: `Exécution automatique : ${e.message}` };
    }
  }
  restore() {
    try {
      if (!this.hasBackup()) return { ok: true, detail: "" };
      let original;
      try { original = JSON.parse(fs.readFileSync(this.backupFile, "utf8")); } catch { original = null; }
      const now = this.read();
      let ok = true;
      // Only undo what we did: if the value is no longer the one we set, the user changed it and it is left alone.
      if (original && now.present && now.value === 1) {
        if (original.present) ok = this.write(original.value);
        else ok = this.run(["delete", AUTOPLAY_KEY, "/v", AUTOPLAY_VALUE, "/f"]).code === 0;
      }
      if (!ok) return { ok: false, detail: "Impossible de remettre l'Exécution automatique de Windows comme avant : elle sera restaurée au prochain démarrage de Compu-Cart." };
      fs.rmSync(this.backupFile, { force: true });
      return { ok: true, detail: "Exécution automatique de Windows remise comme avant." };
    } catch (e) {
      return { ok: false, detail: `Exécution automatique : ${e.message}` };
    }
  }
}

module.exports = { HotplugWatcher, DEFAULT_SETTINGS, readSettings, writeSettings, AutoplayGuard, WM_DEVICECHANGE, deviceEventKind, autoPlays, nextStateAfterSync, StateStore, readManifest, verifyIntegrity, planSync, syncSaves, launchGame, gameWindowScript, waitForGameWindow, introRemaining, safeCopy, driveLetter, parseEjectOutput, ejectCommand, ejectDrive };
