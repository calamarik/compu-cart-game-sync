import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const core = require("../../electron/core.cjs");
const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cc-test-"));
  directories.push(root);
  await mkdir(path.join(root, "cart"));
  return { root, cart: path.join(root, "cart") };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** Writes one game the way the forge does: games/<id>/game.exe + manifests/<id>.json (+ saves/<id>/ when asked). */
async function addGame(cart: string, id: string, extra: Record<string, unknown> = {}) {
  await mkdir(path.join(cart, "games", id), { recursive: true });
  await mkdir(path.join(cart, "manifests"), { recursive: true });
  await writeFile(path.join(cart, "games", id, "game.exe"), `game ${id}`);
  const executable = `games/${id}/game.exe`;
  const manifest = { schemaVersion: 1, id, title: `Game ${id}`, executable, checksums: { [executable]: sha(`game ${id}`) }, ...extra };
  await writeFile(path.join(cart, "manifests", `${id}.json`), JSON.stringify(manifest));
  return manifest;
}
const writeIndex = (cart: string, index: unknown) => writeFile(path.join(cart, "compucart.json"), JSON.stringify(index));

describe("Windows desktop core", () => {
  it("verifies the executable hash and rejects changed game bytes", async () => {
    const { cart } = await fixture();
    const manifest = await addGame(cart, "test-game");
    await writeIndex(cart, { schemaVersion: 1, games: ["test-game"] });
    const { games } = await core.readCartridge(cart);
    expect((await core.verifyIntegrity(cart, games[0])).ok).toBe(true);
    await writeFile(path.join(cart, "games", "test-game", "game.exe"), "corrupt");
    expect((await core.verifyIntegrity(cart, manifest)).ok).toBe(false);
  });
  it("creates user save folders, pulls the newer save, then pushes it back with a backup", async () => {
    const { root, cart } = await fixture();
    await mkdir(path.join(cart, "saves", "test-game"), { recursive: true });
    await writeFile(path.join(cart, "saves", "test-game", "slot.sav"), "from cartridge");
    const manifest = { id: "test-game" };
    const first = await core.syncSaves(cart, manifest, path.join(root, "user"));
    expect(await readFile(path.join(first.localDir, "slot.sav"), "utf8")).toBe("from cartridge");
    await writeFile(path.join(first.localDir, "slot.sav"), "new local progress");
    const future = new Date(Date.now() + 10000);
    await utimes(path.join(first.localDir, "slot.sav"), future, future);
    await core.syncSaves(cart, manifest, path.join(root, "user"));
    expect(await readFile(path.join(cart, "saves", "test-game", "slot.sav"), "utf8")).toBe("new local progress");
    expect(await readFile(path.join(cart, "saves", "test-game", "slot.sav.bak"), "utf8")).toBe("from cartridge");
    const again = await core.syncSaves(cart, manifest, path.join(root, "user"));
    expect(again.plan.map((item: { file: string }) => item.file)).toEqual(["slot.sav"]);
  });
});

describe("Cartridge format (compucart.json + manifests/ + games/ + saves/)", () => {
  it("reads a single-game cartridge as a list of one, titled after its game", async () => {
    const { cart } = await fixture();
    await addGame(cart, "berserk-boy");
    await writeIndex(cart, { schemaVersion: 1, games: ["berserk-boy"] });
    const cartridge = await core.readCartridge(cart);
    expect(cartridge.games.map((g: { id: string }) => g.id)).toEqual(["berserk-boy"]);
    expect(cartridge.title).toBe("Game berserk-boy");
  });
  it("reads a compilation in the order of the list, with the title of the cartridge", async () => {
    const { cart } = await fixture();
    await addGame(cart, "b"); await addGame(cart, "a"); await addGame(cart, "c");
    await writeIndex(cart, { schemaVersion: 1, title: "Triple Pack", games: ["c", "a", "b"] });
    const cartridge = await core.readCartridge(cart);
    expect(cartridge.title).toBe("Triple Pack");
    expect(cartridge.games.map((g: { id: string }) => g.id)).toEqual(["c", "a", "b"]);
  });
  it("gives a default title to a compilation without one", async () => {
    const { cart } = await fixture();
    await addGame(cart, "a"); await addGame(cart, "b");
    await writeIndex(cart, { schemaVersion: 1, games: ["a", "b"] });
    expect((await core.readCartridge(cart)).title).toBe("Cartouche multijeu");
  });
  it("detects a cartridge by compucart.json at its root", async () => {
    const { cart } = await fixture();
    const watcher = new core.HotplugWatcher({ letters: "E" });
    expect(watcher.exists(cart)).toBe(false);
    await writeIndex(cart, { schemaVersion: 1, games: ["a"] });
    expect(watcher.exists(cart)).toBe(true);
  });
  it("rejects an unknown schema version, so an old or newer cartridge is not misread", async () => {
    const { cart } = await fixture();
    await addGame(cart, "a");
    await writeIndex(cart, { schemaVersion: 2, games: ["a"] });
    await expect(core.readCartridge(cart)).rejects.toThrow(/schemaVersion/);
    await writeIndex(cart, { games: ["a"] });
    await expect(core.readCartridge(cart)).rejects.toThrow(/schemaVersion/);
  });
  it("rejects an old-format manifest at the root (no games list)", async () => {
    const { cart } = await fixture();
    await writeIndex(cart, { id: "old", title: "Old", executable: "Old/old.exe", saveDir: "saves", checksums: {} });
    await expect(core.readCartridge(cart)).rejects.toThrow(/schemaVersion/);
  });
  it("rejects an empty or missing games list", async () => {
    const { cart } = await fixture();
    await writeIndex(cart, { schemaVersion: 1, games: [] });
    await expect(core.readCartridge(cart)).rejects.toThrow(/games/);
    await writeIndex(cart, { schemaVersion: 1 });
    await expect(core.readCartridge(cart)).rejects.toThrow(/games/);
  });
  it("rejects a listed game without a manifest instead of showing an incomplete menu", async () => {
    const { cart } = await fixture();
    await addGame(cart, "a");
    await writeIndex(cart, { schemaVersion: 1, games: ["a", "ghost"] });
    await expect(core.readCartridge(cart)).rejects.toThrow(/ghost/);
  });
  it("rejects ids that are unsafe as a folder name, duplicates and case-only duplicates", async () => {
    const { cart } = await fixture();
    await addGame(cart, "a");
    for (const games of [["../a"], ["a/b"], ["a b"], [""], [1], ["a", "a"], ["a", "A"]]) {
      await writeIndex(cart, { schemaVersion: 1, games });
      await expect(core.readCartridge(cart)).rejects.toThrow();
    }
  });
  it("rejects a manifest whose id differs from its file name", async () => {
    const { cart } = await fixture();
    const manifest = await addGame(cart, "a");
    await writeFile(path.join(cart, "manifests", "b.json"), JSON.stringify(manifest));
    await writeIndex(cart, { schemaVersion: 1, games: ["b"] });
    await expect(core.readCartridge(cart)).rejects.toThrow(/ne correspond pas/);
  });
  it("rejects invalid manifests: missing checksum for the executable, bad hash, bad args, escaping paths", async () => {
    const { cart } = await fixture();
    await writeIndex(cart, { schemaVersion: 1, games: ["a"] });
    for (const extra of [
      { checksums: {} },
      { checksums: { "games/a/game.exe": "nothex" } },
      { args: "-windowed" },
      { args: [1] },
      { executable: "../outside.exe", checksums: { "../outside.exe": sha("x") } },
      { schemaVersion: 2 },
    ]) {
      await addGame(cart, "a", extra);
      await expect(core.readCartridge(cart)).rejects.toThrow();
    }
  });
  it("accepts optional launch arguments", async () => {
    const { cart } = await fixture();
    await addGame(cart, "a", { args: ["-windowed"] });
    await writeIndex(cart, { schemaVersion: 1, games: ["a"] });
    expect((await core.readCartridge(cart)).games[0].args).toEqual(["-windowed"]);
  });
  it("keeps the saves of each game in its own folder saves/<id>/", async () => {
    const { root, cart } = await fixture();
    for (const id of ["a", "b"]) {
      await mkdir(path.join(cart, "saves", id), { recursive: true });
      await writeFile(path.join(cart, "saves", id, "slot.sav"), `save of ${id}`);
    }
    const user = path.join(root, "user");
    const a = await core.syncSaves(cart, { id: "a" }, user);
    const b = await core.syncSaves(cart, { id: "b" }, user);
    expect(a.localDir).not.toBe(b.localDir);
    expect(await readFile(path.join(a.localDir, "slot.sav"), "utf8")).toBe("save of a");
    expect(await readFile(path.join(b.localDir, "slot.sav"), "utf8")).toBe("save of b");
  });
});

describe("Event-driven detection", () => {
  it("maps Windows device-change messages to arrival, removal and change", () => {
    expect(core.WM_DEVICECHANGE).toBe(0x0219);
    expect(core.deviceEventKind(0x8000)).toBe("arrival");
    expect(core.deviceEventKind(0x8004)).toBe("removal");
    expect(core.deviceEventKind(0x0007)).toBe("change");
    expect(core.deviceEventKind(0x0018)).toBeNull();
  });
  it("does not poll on its own: scans at launch (now, 2 s, 6 s, 15 s) and after a device event only", () => {
    vi.useFakeTimers();
    let checks = 0;
    const w = new core.HotplugWatcher({ letters: "E", exists: () => { checks++; return false; } });
    w.start();
    expect(checks).toBe(1);
    vi.advanceTimersByTime(60000);
    expect(checks).toBe(4);
    vi.advanceTimersByTime(60000);
    expect(checks).toBe(4);
    w.notify("arrival");
    vi.advanceTimersByTime(5000);
    expect(checks).toBe(7);
    w.stop();
    vi.useRealTimers();
  });
  it("reports a cartridge already present at launch as startup, and a plugged one as device", () => {
    vi.useFakeTimers();
    let present = true;
    const w = new core.HotplugWatcher({ letters: "E", exists: () => present });
    const reasons: string[] = [];
    w.on("inserted", (_root: string, reason: string) => reasons.push(reason));
    w.on("removed", () => reasons.push("removed"));
    w.start();
    expect(reasons).toEqual(["startup"]);
    vi.advanceTimersByTime(20000); // the later launch scans must not report it again
    expect(reasons).toEqual(["startup"]);
    present = false; w.notify("removal"); vi.advanceTimersByTime(5000);
    present = true; w.notify("arrival"); vi.advanceTimersByTime(5000);
    expect(reasons).toEqual(["startup", "removed", "device"]);
    w.stop();
    vi.useRealTimers();
  });
  it("finds a cartridge that Windows only mounts a few seconds after launch, still as startup", () => {
    vi.useFakeTimers();
    let present = false;
    const w = new core.HotplugWatcher({ letters: "E", exists: () => present });
    const reasons: string[] = [];
    w.on("inserted", (_root: string, reason: string) => reasons.push(reason));
    w.start();
    expect(reasons).toEqual([]);
    vi.advanceTimersByTime(3000);
    present = true;
    vi.advanceTimersByTime(4000); // the 6 s scan
    expect(reasons).toEqual(["startup"]);
    w.stop();
    vi.useRealTimers();
  });
  it("never touches an ejected drive again until a new arrival", () => {
    let t = 0;
    const touched: string[] = [];
    const w = new core.HotplugWatcher({ letters: "E", now: () => t, exists: (r: string) => { touched.push(r); return true; } });
    const inserted: string[] = [];
    w.on("inserted", (r: string) => inserted.push(r));
    w.scan();
    expect(inserted).toEqual(["E:\\"]);
    w.suppress("E:\\");
    touched.length = 0;
    w.scan();
    expect(touched).toEqual([]);
    t = 1000; w.notify("arrival"); w.stop(); w.scan();
    expect(touched).toEqual([]);
    t = 5000; w.notify("arrival"); w.stop(); w.scan();
    expect(inserted).toEqual(["E:\\", "E:\\"]);
  });
});

describe("Ready or auto-play", () => {
  it("starts the game by itself only for a cartridge plugged in while running", () => {
    expect(core.autoPlays("device")).toBe(true);
    expect(core.autoPlays("startup")).toBe(false);
    expect(core.autoPlays("manual")).toBe(false);
    expect(core.nextStateAfterSync("device")).toBe("intro");
    expect(core.nextStateAfterSync("startup")).toBe("ready");
    expect(core.nextStateAfterSync("manual")).toBe("ready");
  });
  it("with auto launch off, a plugged cartridge stops on ready too (Play button or Enter starts it)", () => {
    expect(core.autoPlays("device", false)).toBe(false);
    expect(core.nextStateAfterSync("device", false)).toBe("ready");
    expect(core.nextStateAfterSync("startup", false)).toBe("ready");
  });
  it("a cartridge with several games never launches by itself: the player picks the game", () => {
    expect(core.nextStateAfterSync("device", true, 2)).toBe("ready");
    expect(core.nextStateAfterSync("device", true, 5)).toBe("ready");
    expect(core.nextStateAfterSync("device", true, 1)).toBe("intro");
  });
  it("with auto launch on, or when the option is unknown, nothing changes", () => {
    expect(core.autoPlays("device", true)).toBe(true);
    expect(core.autoPlays("device", undefined)).toBe(true);
    expect(core.nextStateAfterSync("device", true)).toBe("intro");
    expect(core.autoPlays("startup", true)).toBe(false);
  });
});

describe("Console state kept for a late window", () => {
  it("starts empty", () => {
    expect(new core.StateStore().snapshot()).toEqual({ cart: { state: "empty" }, integrity: null, sync: null, logs: [] });
  });
  it("returns the latest cartridge, integrity and sync, with logs newest first and capped", () => {
    const s = new core.StateStore(3);
    s.setCart({ state: "ready", root: "E:\\" });
    s.setIntegrity({ ok: true, results: [] });
    s.setSync({ plan: [] });
    ["a", "b", "c", "d"].forEach((msg, at) => s.addLog({ level: "info", msg, at }));
    const snap = s.snapshot();
    expect(snap.cart).toEqual({ state: "ready", root: "E:\\" });
    expect(snap.integrity).toEqual({ ok: true, results: [] });
    expect(snap.sync).toEqual({ plan: [] });
    expect(snap.logs.map((l: { msg: string }) => l.msg)).toEqual(["d", "c", "b"]);
    s.setCart({ state: "empty" }); s.setIntegrity(null); s.setSync(null);
    expect(s.snapshot()).toMatchObject({ cart: { state: "empty" }, integrity: null, sync: null });
  });
});

describe("Windows AutoPlay option", () => {
  /** In-memory stand-in for reg.exe: only the DisableAutoplay value. null = value absent. */
  function fakeReg(initial: number | null) {
    const state = { value: initial, writes: 0, failWrites: false };
    const run = (args: string[]) => {
      if (args[0] === "query") {
        return state.value === null
          ? { code: 1, out: "ERROR: The system was unable to find the specified registry key or value." }
          : { code: 0, out: `\nHKEY_CURRENT_USER\\Software\\...\\AutoplayHandlers\n    DisableAutoplay    REG_DWORD    0x${state.value.toString(16)}\n\n` };
      }
      if (state.failWrites) return { code: 1, out: "ERROR: Access is denied." };
      if (args[0] === "add") { state.value = Number(args[args.indexOf("/d") + 1]); state.writes++; return { code: 0, out: "" }; }
      if (args[0] === "delete") { state.value = null; state.writes++; return { code: 0, out: "" }; }
      return { code: 1, out: "" };
    };
    return { state, run };
  }
  async function guard(initial: number | null) {
    const dir = await mkdtemp(path.join(tmpdir(), "cc-autoplay-"));
    directories.push(dir);
    const reg = fakeReg(initial);
    const g = new core.AutoplayGuard({ backupFile: path.join(dir, "sub", "autoplay-backup.json"), run: reg.run });
    return { g, reg, dir };
  }

  it("is off by default and settings survive a missing or broken file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cc-settings-"));
    directories.push(dir);
    const file = path.join(dir, "settings.json");
    expect(core.readSettings(file)).toEqual({ disableAutoplay: false, autoLaunch: true });
    core.writeSettings(file, { disableAutoplay: true, autoLaunch: false });
    expect(core.readSettings(file)).toEqual({ disableAutoplay: true, autoLaunch: false });
    await writeFile(file, JSON.stringify({ disableAutoplay: true })); // file written before auto launch existed
    expect(core.readSettings(file)).toEqual({ disableAutoplay: true, autoLaunch: true });
    await writeFile(file, "{ not json");
    expect(core.readSettings(file)).toEqual({ disableAutoplay: false, autoLaunch: true });
  });
  it("turns AutoPlay off, then puts back the previous value (set to 0)", async () => {
    const { g, reg } = await guard(0);
    expect(g.enable().ok).toBe(true);
    expect(reg.state.value).toBe(1);
    expect(g.hasBackup()).toBe(true);
    expect(g.restore().ok).toBe(true);
    expect(reg.state.value).toBe(0);
    expect(g.hasBackup()).toBe(false);
  });
  it("removes the value again when there was none before", async () => {
    const { g, reg } = await guard(null);
    g.enable();
    expect(reg.state.value).toBe(1);
    g.restore();
    expect(reg.state.value).toBeNull();
    expect(g.hasBackup()).toBe(false);
  });
  it("keeps the ORIGINAL value when enabled twice (a crash then a restart)", async () => {
    const { g, reg } = await guard(0);
    g.enable();
    g.enable(); // value is already 1: must not be saved as the "previous" one
    g.restore();
    expect(reg.state.value).toBe(0);
  });
  it("restores a leftover backup after a crash, from a new guard on the same backup file", async () => {
    const { g, reg, dir } = await guard(0);
    g.enable();
    const later = new core.AutoplayGuard({ backupFile: path.join(dir, "sub", "autoplay-backup.json"), run: reg.run });
    expect(later.hasBackup()).toBe(true);
    later.restore();
    expect(reg.state.value).toBe(0);
  });
  it("leaves a value alone if the user changed it by hand in the meantime", async () => {
    const { g, reg } = await guard(0);
    g.enable();
    reg.state.value = 5;
    expect(g.restore().ok).toBe(true);
    expect(reg.state.value).toBe(5);
    expect(g.hasBackup()).toBe(false);
  });
  it("does nothing when there is nothing to restore", async () => {
    const { g, reg } = await guard(1);
    expect(g.restore()).toMatchObject({ ok: true });
    expect(reg.state.writes).toBe(0);
    expect(reg.state.value).toBe(1);
  });
  it("reports a refused change without keeping a backup, and without throwing", async () => {
    const { g, reg } = await guard(0);
    reg.state.failWrites = true;
    const r = g.enable();
    expect(r.ok).toBe(false);
    expect(g.hasBackup()).toBe(false);
    expect(reg.state.value).toBe(0);
  });
  it("keeps the backup when the restore is refused, so that the next start can retry", async () => {
    const { g, reg } = await guard(0);
    g.enable();
    reg.state.failWrites = true;
    expect(g.restore().ok).toBe(false);
    expect(g.hasBackup()).toBe(true);
    reg.state.failWrites = false;
    expect(g.restore().ok).toBe(true);
    expect(reg.state.value).toBe(0);
  });
});

describe("Safe eject", () => {
  it("accepts only cartridge drive letters D to Z", () => {
    expect(core.driveLetter("e:\\")).toBe("E");
    expect(() => core.driveLetter("C:\\")).toThrow();
    expect(() => core.driveLetter("E:\\'; rm")).toThrow();
  });
  it("reports safe removal only when Windows disconnected the device", () => {
    expect(core.parseEjectOutput("noise\r\nOK\r\n").status).toBe("removed");
    expect(core.parseEjectOutput("BUSY").status).toBe("busy");
    expect(core.parseEjectOutput("VETO:6:USB\\VID_1234").status).toBe("vetoed");
    expect(core.parseEjectOutput("ERR:Accès refusé")).toEqual({ status: "error", detail: "Accès refusé" });
    expect(core.parseEjectOutput("").status).toBe("error");
  });
  it("passes the validated letter to PowerShell as an encoded command", () => {
    const cmd = core.ejectCommand("F:\\", "Write-Output $Lettre");
    expect(cmd.file).toBe("powershell.exe");
    const script = Buffer.from(cmd.args.at(-1), "base64").toString("utf16le");
    expect(script.startsWith("$Lettre = 'F'\n")).toBe(true);
  });
});
describe("Intro pendant le chargement", () => {
  const fakeChild = () => {
    const { EventEmitter } = require("node:events");
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = vi.fn(() => child.emit("exit", null));
    return child;
  };

  it("builds a script that looks for a window of a process started from the cartridge", () => {
    const script = core.gameWindowScript("E:\\");
    expect(script).toContain("$p='E:\\'");
    expect(script).toContain("MainWindowHandle");
    expect(core.gameWindowScript("E:\\").includes("E:\\\\")).toBe(false);
  });

  it("never lets the intro end before its minimum duration", () => {
    expect(core.introRemaining(1000, 1500, 3200)).toBe(2700);
    expect(core.introRemaining(1000, 9000, 3200)).toBe(0);
  });

  it("resolves 'window' when the detector prints FOUND, and stops the detector", async () => {
    const child = fakeChild();
    const watch = core.waitForGameWindow("E:\\", { spawnFn: () => child, platform: "win32" });
    child.stdout.emit("data", "FOUND\r\n");
    expect(await watch.done).toBe("window");
    expect(child.kill).toHaveBeenCalled();
  });

  it("resolves 'timeout' when no window shows up, 'cancelled' when the game exits first", async () => {
    const slow = fakeChild();
    expect(await core.waitForGameWindow("E:\\", { spawnFn: () => slow, platform: "win32", timeoutMs: 20 }).done).toBe("timeout");
    const gone = fakeChild();
    const watch = core.waitForGameWindow("E:\\", { spawnFn: () => gone, platform: "win32" });
    watch.cancel();
    expect(await watch.done).toBe("cancelled");
    expect(gone.kill).toHaveBeenCalled();
  });

  it("falls back to 'timeout' when the detector cannot start", async () => {
    const boom = () => { throw new Error("no powershell"); };
    expect(await core.waitForGameWindow("E:\\", { spawnFn: boom, platform: "win32" }).done).toBe("timeout");
  });

  it("brings the game window forward: script targets the cartridge processes, runs a limited time and can be cancelled", () => {
    const script = core.focusGameScript("E:\\", 5000);
    expect(script).toContain("SetForegroundWindow");
    expect(script).toContain("$p='E:\\'");
    expect(script).toContain("AddMilliseconds(5000)");
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const focus = core.focusGameWindow("E:\\", { spawnFn, platform: "win32" });
    expect(spawnFn).toHaveBeenCalledWith("powershell.exe", expect.arrayContaining(["-EncodedCommand"]), expect.anything());
    focus.cancel();
    expect(child.kill).toHaveBeenCalled();
    expect(() => core.focusGameWindow("E:\\", { spawnFn: () => { throw new Error("x"); }, platform: "win32" }).cancel()).not.toThrow();
  });

  it.skipIf(process.platform === "win32")("passes the game process to onSpawn at start", async () => {
    const { cart } = await fixture();
    const exe = path.join(cart, "game.sh");
    await writeFile(exe, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    let pid = 0;
    const code = await core.launchGame(cart, { executable: "game.sh" }, (child: any) => { pid = child.pid; });
    expect(pid).toBeGreaterThan(0);
    expect(code).toBe(3);
  });
});
