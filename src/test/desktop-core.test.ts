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
  it("does not poll on its own: scans only at start and after a device event", () => {
    vi.useFakeTimers();
    let checks = 0;
    const w = new core.HotplugWatcher({ letters: "E", exists: () => { checks++; return false; } });
    w.start();
    expect(checks).toBe(1);
    vi.advanceTimersByTime(60000);
    expect(checks).toBe(1);
    w.notify("arrival");
    vi.advanceTimersByTime(5000);
    expect(checks).toBe(4);
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

describe("Safe eject", () => {
  it("accepts only cartridge drive letters D to Z", () => {
    expect(core.driveLetter("e:\\")).toBe("E");
    expect(() => core.driveLetter("C:\\")).toThrow();
    expect(() => core.driveLetter("E:\\'; rm")).toThrow();
  });
  it("reports safe removal only when Windows disconnected the device", () => {
    expect(core.parseEjectOutput("noise\r\nOK\r\n").status).toBe("removed");
    expect(core.parseEjectOutput("BUSY").status).toBe("busy");
    expect(core.parseEjectOutput("VETO:6:USB\\VID_1234").status).toBe("flushed");
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