const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const core = require("./core.cjs");

let win;
const send = (ch, data) => win && win.webContents.send(ch, data);
const log = (level, msg) => send("cc:log", { level, msg, at: Date.now() });

async function handleInsert(root) {
  try {
    log("info", `Cartouche détectée sur ${root}`);
    const manifest = await core.readManifest(root);
    send("cc:cart", { state: "verifying", root, manifest });
    const integrity = await core.verifyIntegrity(root, manifest);
    send("cc:integrity", integrity);
    if (!integrity.ok) {
      log("error", "Intégrité compromise — lancement bloqué");
      return send("cc:cart", { state: "corrupt", root, manifest });
    }
    log("ok", "Intégrité vérifiée");
    send("cc:cart", { state: "syncing", root, manifest });
    const sync = await core.syncSaves(root, manifest, app.getPath("appData"));
    send("cc:sync", sync);
    log("ok", `Sauvegardes synchronisées (${sync.plan.filter((p) => p.action !== "skip").length} fichier(s))`);
    // Intro assets as data URLs so the renderer can play them.
    const asset = (rel, mime) => {
      if (!rel) return null;
      const f = path.join(root, rel);
      return fs.existsSync(f) ? `data:${mime};base64,${fs.readFileSync(f).toString("base64")}` : null;
    };
    send("cc:cart", { state: "intro", root, manifest, intro: { image: asset(manifest.intro.image, "image/png"), audio: asset(manifest.intro.audio, "audio/mpeg") } });
  } catch (e) {
    log("error", e.message);
    send("cc:cart", { state: "error", root });
  }
}

ipcMain.handle("cc:launch", async (_e, root) => {
  const manifest = await core.readManifest(root);
  send("cc:cart", { state: "running", root, manifest });
  log("info", `Lancement de ${manifest.title}`);
  try {
    const code = await core.launchGame(root, manifest);
    log("info", `Jeu terminé (code ${code}) — synchronisation retour`);
    send("cc:sync", await core.syncSaves(root, manifest, app.getPath("appData")));
  } catch (e) { log("error", e.message); }
  send("cc:cart", { state: "ready", root, manifest });
});

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280, height: 820, backgroundColor: "#0d0b08",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(process.env.COMPUCART_URL || "http://localhost:8080");
  const watcher = new core.HotplugWatcher();
  watcher.on("inserted", handleInsert);
  watcher.on("removed", (r) => { log("warn", `Cartouche retirée (${r})`); send("cc:cart", { state: "empty" }); });
  win.webContents.on("did-finish-load", () => watcher.start());
});
app.on("window-all-closed", () => app.quit());
