const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, powerMonitor } = require("electron");
const path = require("path");
const fs = require("fs");
const core = require("./core.cjs");

const LOGIN = { path: process.execPath, args: ["--background"], name: "Compu-Cart" };
const autostartEnabled = () => app.getLoginItemSettings(LOGIN).openAtLogin;
const setAutostart = (on) => app.setLoginItemSettings({ ...LOGIN, openAtLogin: on });
const flag = (argv, name) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

if (process.argv.includes("--configure-only")) {
  // Used by the installer/uninstaller: apply settings and exit without UI.
  app.whenReady().then(() => {
    const auto = flag(process.argv, "autostart");
    if (auto) setAutostart(auto === "on");
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

function run() {
  let win;
  let tray;
  let watcher;
  let currentCart;
  let launching = false;
  let quitting = false;
  let autoShown = false;
  let trayHintShown = false;
  const startHidden = process.argv.includes("--background");
  const icon = path.join(__dirname, "assets", process.platform === "win32" ? "icon.ico" : "icon.png");

  const alive = () => win && !win.isDestroyed();
  const send = (ch, data) => alive() && win.webContents.send(ch, data);
  const log = (level, msg) => send("cc:log", { level, msg, at: Date.now() });
  const setCart = (data) => { send("cc:cart", data); refreshTray(); };

  /** Borderless fullscreen in front of everything (hides the desktop). */
  function showConsole() {
    if (!alive()) return;
    win.setAlwaysOnTop(true, "screen-saver");
    win.show();
    win.setFullScreen(true);
    win.focus();
    win.moveTop();
    setTimeout(() => alive() && win.setAlwaysOnTop(false), 400);
  }
  function hideConsole() {
    if (!alive()) return;
    win.hide();
    autoShown = false;
    if (!trayHintShown && tray && process.platform === "win32") {
      trayHintShown = true;
      tray.displayBalloon({ title: "Compu-Cart reste actif", content: "Compu-Cart surveille les cartouches depuis la zone de notification." });
    }
  }

  const canEject = () => currentCart && !launching && !currentCart.ejecting && ["ready", "intro", "corrupt", "error"].includes(currentCart.state);

  function refreshTray() {
    if (!tray) return;
    const running = launching;
    tray.setToolTip(currentCart ? `Compu-Cart — ${currentCart.title || currentCart.root}` : "Compu-Cart — en attente de cartouche");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Afficher Compu-Cart", click: showConsole },
      { label: currentCart ? `Éjecter la cartouche (${currentCart.root})` : "Éjecter la cartouche", enabled: !!canEject(), click: () => ejectCurrent() },
      { type: "separator" },
      { label: "Démarrer avec Windows", type: "checkbox", checked: autostartEnabled(), click: (item) => { setAutostart(item.checked); refreshTray(); } },
      { type: "separator" },
      { label: running ? "Quitter (jeu en cours…)" : "Quitter", enabled: !running, click: () => { quitting = true; app.quit(); } },
    ]));
  }

  async function handleInsert(root) {
    if (currentCart) { log("warn", `Une cartouche est déjà active — ${root} ignoré`); return; }
    const cart = { root, state: "verifying" };
    currentCart = cart;
    if (!win.isVisible()) { autoShown = true; showConsole(); }
    try {
      log("info", `Cartouche détectée sur ${root}`);
      const manifest = await core.readManifest(root);
      cart.title = manifest.title;
      setCart({ state: "verifying", root, manifest });
      const integrity = await core.verifyIntegrity(root, manifest);
      if (currentCart !== cart) return;
      send("cc:integrity", integrity);
      if (!integrity.ok) {
        log("error", "Intégrité compromise — lancement bloqué");
        cart.state = "corrupt";
        return setCart({ state: "corrupt", root, manifest });
      }
      log("ok", "Intégrité vérifiée");
      cart.state = "syncing";
      setCart({ state: "syncing", root, manifest });
      const sync = await core.syncSaves(root, manifest, app.getPath("appData"));
      if (currentCart !== cart) return;
      send("cc:sync", sync);
      log("ok", `Sauvegardes synchronisées (${sync.plan.filter((p) => p.action !== "skip").length} fichier(s))`);
      const asset = (rel, mime) => {
        if (!rel) return null;
        const f = path.join(root, rel);
        return fs.existsSync(f) ? `data:${mime};base64,${fs.readFileSync(f).toString("base64")}` : null;
      };
      cart.state = "intro";
      setCart({ state: "intro", root, manifest, intro: { image: asset(manifest.intro.image, "image/png"), audio: asset(manifest.intro.audio, "audio/mpeg") } });
    } catch (e) {
      if (currentCart !== cart) return;
      log("error", e.message);
      cart.state = "error";
      setCart({ state: "error", root });
    }
  }

  async function ejectCurrent() {
    const cart = currentCart;
    if (!canEject()) { log("warn", launching ? "Fermez le jeu avant d'éjecter" : "Rien à éjecter pour le moment"); return; }
    const previous = cart.state;
    cart.ejecting = true;
    cart.state = "ejecting";
    setCart({ state: "ejecting", root: cart.root });
    log("info", `Éjection de ${cart.root} : écriture des données en attente…`);
    try {
      const result = await core.ejectDrive(cart.root);
      if (result.status === "removed" || result.status === "flushed") {
        watcher.suppress(cart.root);
        currentCart = null;
        send("cc:integrity", null); send("cc:sync", null);
        if (result.status === "removed") log("ok", "Cartouche éjectée : vous pouvez la retirer en toute sécurité");
        else log("warn", `${result.detail} Vous pouvez la retirer si aucun autre programme ne l'utilise.`);
        setCart({ state: "ejected", root: cart.root });
        setTimeout(() => {
          if (currentCart) return;
          setCart({ state: "empty" });
          if (autoShown) hideConsole();
        }, 6000);
        return;
      }
      log("error", `Éjection refusée : ${result.detail}`);
    } catch (e) {
      log("error", `Éjection impossible : ${e.message}`);
    }
    if (currentCart === cart) { cart.ejecting = false; cart.state = previous; setCart({ state: previous, root: cart.root }); }
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
      if (!integrity.ok) { cart.state = "corrupt"; setCart({ state: "corrupt", root, manifest }); throw new Error("Intégrité compromise — lancement bloqué"); }
      cart.state = "running";
      setCart({ state: "running", root, manifest });
      log("info", `Lancement de ${manifest.title}`);
      // The console stays fullscreen behind the game: resolution changes never reveal the desktop.
      win.setAlwaysOnTop(false);
      const code = await core.launchGame(root, manifest);
      showConsole();
      log("info", `Jeu terminé (code ${code}) — synchronisation retour`);
      if (currentCart !== cart) { log("warn", "Cartouche absente : sauvegardes locales conservées, retour reporté"); return; }
      send("cc:sync", await core.syncSaves(root, manifest, app.getPath("appData")));
      cart.state = "ready";
      setCart({ state: "ready", root, manifest });
    } catch (e) {
      log("error", e.message);
      if (currentCart === cart) { cart.state = "error"; setCart({ state: "error", root, manifest }); }
    } finally {
      launching = false;
      refreshTray();
    }
  });
  ipcMain.handle("cc:eject", () => ejectCurrent());
  ipcMain.handle("cc:hide", () => hideConsole());
  ipcMain.handle("cc:quit", () => {
    if (launching) return log("warn", "Fermez le jeu avant de quitter Compu-Cart");
    quitting = true;
    app.quit();
  });

  app.on("second-instance", () => showConsole());
  app.whenReady().then(() => {
    if (process.platform === "win32") app.setAppUserModelId("fr.compucart.console");
    win = new BrowserWindow({
      width: 1280, height: 820, show: false, frame: false, backgroundColor: "#0d0b08",
      autoHideMenuBar: true, icon, title: "Compu-Cart",
      webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: "no-user-gesture-required" },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.on("close", (event) => { if (!quitting) { event.preventDefault(); hideConsole(); } });
    if (app.isPackaged || !process.env.COMPUCART_URL) win.loadFile(path.join(__dirname, "renderer", "index.html"));
    else win.loadURL(process.env.COMPUCART_URL);

    // Re-fit the fullscreen window if a game changed the display resolution.
    screen.on("display-metrics-changed", () => {
      if (alive() && win.isVisible() && win.isFullScreen()) win.setBounds(screen.getDisplayMatching(win.getBounds()).bounds);
    });

    tray = new Tray(nativeImage.createFromPath(icon));
    tray.on("click", showConsole);
    tray.on("double-click", showConsole);
    refreshTray();

    if (process.platform === "win32") {
      // Event-driven detection: Windows broadcasts WM_DEVICECHANGE to top-level windows (hidden ones too).
      watcher = new core.HotplugWatcher();
      win.hookWindowMessage(core.WM_DEVICECHANGE, (wParam) => {
        const kind = core.deviceEventKind(wParam.readUInt32LE(0));
        if (kind) watcher.notify(kind);
      });
    } else {
      watcher = new core.HotplugWatcher({ pollMs: 1500 });
    }
    powerMonitor.on("resume", () => watcher.notify("change"));
    watcher.on("inserted", handleInsert);
    watcher.on("removed", (r) => {
      if (currentCart?.root !== r) return;
      currentCart = null;
      log("warn", `Cartouche retirée (${r})`);
      setCart({ state: "empty" });
      send("cc:integrity", null); send("cc:sync", null);
    });
    win.webContents.once("did-finish-load", () => {
      if (!startHidden) showConsole();
      watcher.start();
    });
  });
  app.on("before-quit", () => { quitting = true; watcher?.stop(); });
  app.on("window-all-closed", () => app.quit());
}
