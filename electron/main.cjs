const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const core = require("./core.cjs");

let win;
let watcher;
let currentCart;
let launching = false;
const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
const log = (level, msg) => send("cc:log", { level, msg, at: Date.now() });

async function handleInsert(root) {
  if (currentCart) { log("warn", `Une cartouche est déjà active — ${root} ignoré`); return; }
  const cart = { root, state: "verifying" };
  currentCart = cart;
  try {
    log("info", `Cartouche détectée sur ${root}`);
    const manifest = await core.readManifest(root);
    send("cc:cart", { state: "verifying", root, manifest });
    const integrity = await core.verifyIntegrity(root, manifest);
    if (currentCart !== cart) return;
    send("cc:integrity", integrity);
    if (!integrity.ok) {
      log("error", "Intégrité compromise — lancement bloqué");
      return send("cc:cart", { state: "corrupt", root, manifest });
    }
    log("ok", "Intégrité vérifiée");
    send("cc:cart", { state: "syncing", root, manifest });
    const sync = await core.syncSaves(root, manifest, app.getPath("appData"));
    if (currentCart !== cart) return;
    send("cc:sync", sync);
    log("ok", `Sauvegardes synchronisées (${sync.plan.filter((p) => p.action !== "skip").length} fichier(s))`);
    // Intro assets as data URLs so the renderer can play them.
    const asset = (rel, mime) => {
      if (!rel) return null;
      const f = path.join(root, rel);
      return fs.existsSync(f) ? `data:${mime};base64,${fs.readFileSync(f).toString("base64")}` : null;
    };
    send("cc:cart", { state: "intro", root, manifest, intro: { image: asset(manifest.intro.image, "image/png"), audio: asset(manifest.intro.audio, "audio/mpeg") } });
    cart.state = "intro";
  } catch (e) {
    if (currentCart !== cart) return;
    log("error", e.message);
    send("cc:cart", { state: "error", root });
  }
}

ipcMain.handle("cc:launch", async (_e, root) => {
  const cart = currentCart;
  if (!cart || cart.root !== root || cart.state !== "intro" || launching) return;
  launching = true;
  let manifest;
  try {
    manifest = await core.readManifest(root);
    const integrity = await core.verifyIntegrity(root, manifest);
    if (currentCart !== cart) return;
    if (!integrity.ok) { send("cc:cart", { state: "corrupt", root, manifest }); throw new Error("Intégrité compromise — lancement bloqué"); }
    cart.state = "running";
    send("cc:cart", { state: "running", root, manifest });
    log("info", `Lancement de ${manifest.title}`);
    const code = await core.launchGame(root, manifest);
    log("info", `Jeu terminé (code ${code}) — synchronisation retour`);
    if (currentCart !== cart) { log("warn", "Cartouche absente : sauvegardes locales conservées, retour reporté"); return; }
    send("cc:sync", await core.syncSaves(root, manifest, app.getPath("appData")));
    send("cc:cart", { state: "ready", root, manifest });
    cart.state = "ready";
  } catch (e) { log("error", e.message); if (currentCart === cart) send("cc:cart", { state: "error", root, manifest }); }
  finally { launching = false; }
});

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (win && !win.isDestroyed()) { win.restore(); win.focus(); } });
app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280, height: 820, backgroundColor: "#0d0b08",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: "no-user-gesture-required" },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  if (app.isPackaged || !process.env.COMPUCART_URL) win.loadFile(path.join(__dirname, "renderer", "index.html"));
  else win.loadURL(process.env.COMPUCART_URL);
  watcher = new core.HotplugWatcher();
  watcher.on("inserted", handleInsert);
  watcher.on("removed", (r) => {
    if (currentCart?.root !== r) return;
    currentCart = null;
    log("warn", `Cartouche retirée (${r})`); send("cc:cart", { state: "empty" });
    send("cc:integrity", null); send("cc:sync", null);
  });
  win.webContents.once("did-finish-load", () => watcher.start());
});
app.on("before-quit", () => watcher?.stop());
app.on("window-all-closed", () => app.quit());
