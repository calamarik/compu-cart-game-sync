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
describe("Windows desktop core", () => {
  it("verifies the executable hash and rejects changed game bytes", async () => {
    const { cart } = await fixture();
    await writeFile(path.join(cart, "game.exe"), "game");
    const manifest = { id: "test-game", title: "Test", executable: "game.exe", checksums: { "game.exe": createHash("sha256").update("game").digest("hex") } };
    await writeFile(path.join(cart, "compucart.json"), JSON.stringify(manifest));
    expect((await core.verifyIntegrity(cart, await core.readManifest(cart))).ok).toBe(true);
    await writeFile(path.join(cart, "game.exe"), "corrupt");
    expect((await core.verifyIntegrity(cart, manifest)).ok).toBe(false);
  });
  it("creates user save folders, pulls the newer save, then pushes it back with a backup", async () => {
    const { root, cart } = await fixture();
    await mkdir(path.join(cart, "saves"));
    await writeFile(path.join(cart, "saves", "slot.sav"), "from cartridge");
    const manifest = { id: "test-game", saveDir: "saves" };
    const first = await core.syncSaves(cart, manifest, path.join(root, "user"));
    expect(await readFile(path.join(first.localDir, "slot.sav"), "utf8")).toBe("from cartridge");
    await writeFile(path.join(first.localDir, "slot.sav"), "new local progress");
    const future = new Date(Date.now() + 10000);
    await utimes(path.join(first.localDir, "slot.sav"), future, future);
    await core.syncSaves(cart, manifest, path.join(root, "user"));
    expect(await readFile(path.join(cart, "saves", "slot.sav"), "utf8")).toBe("new local progress");
    expect(await readFile(path.join(cart, "saves", "slot.sav.bak"), "utf8")).toBe("from cartridge");
    const again = await core.syncSaves(cart, manifest, path.join(root, "user"));
    expect(again.plan.map((item: { file: string }) => item.file)).toEqual(["slot.sav"]);
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