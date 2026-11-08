import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

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