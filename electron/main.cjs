const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, powerMonitor } = require("electron");
const path = require("path");
const fs = require("fs");
const core = require("./core.cjs");

const LOGIN = { path: process.execPath, args: ["--background"], name: "Compu-Cart" };
const autostartEnabled = () => app.getLoginItemSettings(LOGIN).openAtLogin;
const setAutostart = (on) => app.setLoginItemSettings({ ...LOGIN, openAtLogin: on });
const flag = (argv, name) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
const autoplayGuard = () => new core.AutoplayGuard({ backupFile: path.join(app.getPath("userData"), "autoplay-backup.json") });

if (process.argv.includes("--configure-only")) {
  // Used by the installer/uninstaller: apply settings and exit without UI.
  app.whenReady().then(() => {
    const auto = flag(process.argv, "autostart");
    if (auto) setAutostart(auto === "on");
    // The uninstaller kills Compu-Cart, so it may not have restored the Windows AutoPlay setting itself.
    if (flag(process.argv, "autoplay") === "restore" && process.platform === "win32") autoplayGuard().restore();
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
  const autoplay = autoplayGuard();
  let settings = core.readSettings(settingsFile());
  let autoShown = false;
  let trayHintShown = false;
  const startHidden = process.argv.includes("--background");
  const icon = path.join(__dirname, "assets", process.platform === "win32" ? "icon.ico" : "icon.png");

  const store = new core.StateStore();
  const alive = () => win && !win.isDestroyed();
  // Every update is also kept in the store, so a window that opens after a detection can ask for it (cc:state).
  const send = (ch, data) => {
    if (ch === "cc:cart") store.setCart(data);
    else if (ch === "cc:integrity") store.setIntegrity(data);
    else if (ch === "cc:sync") store.setSync(data);
    else if (ch === "cc:log") store.addLog(data);
    return alive() && win.webContents.send(ch, data);
  };
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
  const canPlay = () => currentCart && !launching && !currentCart.ejecting && currentCart.state === "ready";

  /** Windows balloon when a cartridge found at startup is ready while the console is hidden (background start). */
  function notifyReady(manifest) {
    if (process.platform !== "win32" || !tray || (alive() && win.isVisible())) return;
    tray.displayBalloon({ title: "Cartouche prête", content: `${manifest.title} est prête. Cliquez ici, puis sur « Jouer ».`, iconType: "info" });
  }

  /** Applies the saved option at startup. With the option off, a backup left by a crash is restored. */
  function syncAutoplayAtStartup() {
    if (process.platform !== "win32") return;
    if (settings.disableAutoplay) {
      const r = autoplay.enable();
      log(r.ok ? "info" : "warn", r.detail);
    } else if (autoplay.hasBackup()) {
      const r = autoplay.restore();
      log(r.ok ? "info" : "warn", r.detail);
    }
  }

  /** "Lancement automatique" (tray checkbox or console toggle): on = a plugged cartridge starts its game by itself; off = it stops on "Prête". */
  function setAutoLaunch(on) {
    settings = { ...settings, autoLaunch: !!on };
    try { core.writeSettings(settingsFile(), settings); } catch (e) { log("warn", `Option non enregistrée : ${e.message}`); }
    log("info", on ? "Lancement automatique activé : la cartouche branchée lance son jeu" : "Lancement automatique désactivé : appuyez sur « Jouer » ou Entrée");
    send("cc:settings", { autoLaunch: settings.autoLaunch !== false });
    refreshTray();
  }

  /** Tray checkbox: saves the choice, then turns the Windows AutoPlay setting off or back to what it was. */
  function setAutoplayOption(on) {
    const r = on ? autoplay.enable() : autoplay.restore();
    log(r.ok ? "info" : "warn", r.detail);
    settings = { ...settings, disableAutoplay: on && r.ok };
    try { core.writeSettings(settingsFile(), settings); } catch (e) { log("warn", `Option non enregistrée : ${e.message}`); }
    refreshTray();
  }

  function refreshTray() {
    if (!tray) return;
    const running = launching;
    tray.setToolTip(currentCart ? `Compu-Cart — ${currentCart.title || currentCart.root}` : "Compu-Cart — en attente de cartouche");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Afficher Compu-Cart", click: showConsole },
      { label: currentCart?.title ? `▶ Jouer à ${currentCart.title}` : "▶ Jouer", enabled: !!canPlay(), click: () => playCurrent() },
      { label: currentCart ? `Éjecter la cartouche (${currentCart.root})` : "Éjecter la cartouche", enabled: !!canEject(), click: () => ejectCurrent() },
      { type: "separator" },
      { label: "Démarrer avec Windows", type: "checkbox", checked: autostartEnabled(), click: (item) => { setAutostart(item.checked); refreshTray(); } },
      { label: "Lancer le jeu automatiquement au branchement", type: "checkbox", checked: settings.autoLaunch !== false, click: (item) => setAutoLaunch(item.checked) },
      ...(process.platform === "win32" ? [{ label: "Désactiver l'exécution automatique de Windows pendant que Compu-Cart tourne", type: "checkbox", checked: !!settings.disableAutoplay, click: (item) => setAutoplayOption(item.checked) }] : []),
      { type: "separator" },
      { label: running ? "Quitter (jeu en cours…)" : "Quitter", enabled: !running, click: () => { quitting = true; app.quit(); } },
    ]));
  }

  /** Intro image and sound of the cartridge as data URLs (null when absent). */
  function introPayload(root, manifest) {
    const asset = (rel, mime) => {
      if (!rel) return null;
      const f = path.join(root, rel);
      return fs.existsSync(f) ? `data:${mime};base64,${fs.readFileSync(f).toString("base64")}` : null;
    };
    return { image: asset(manifest.intro?.image, "image/png"), audio: asset(manifest.intro?.audio, "audio/mpeg") };
  }

  /** reason "startup": cartridge already there at launch (stops on "Prête"); "device": plugged while running (intro, then the game starts by itself). */
  async function handleInsert(root, reason = "device") {
    if (currentCart) { log("warn", `Une cartouche est déjà active — ${root} ignoré`); return; }
    const cart = { root, state: "verifying" };
    currentCart = cart;
    // Only a plug-in event brings the console to the front by itself; a cartridge found at launch must not take over the screen.
    if (reason === "device" && !win.isVisible()) { autoShown = true; showConsole(); }
    try {
      log("info", reason === "device" ? `Cartouche détectée sur ${root}` : `Cartouche déjà présente sur ${root}`);
      const manifest = await core.readManifest(root);
      cart.title = manifest.title;
      cart.manifest = manifest;
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
      if (core.nextStateAfterSync(reason, settings.autoLaunch) === "ready") {
        // Plugged in with auto launch off: show the console (the Play button or Enter starts the game). Found at launch: stay quiet.
        if (reason === "device") showConsole();
        cart.state = "ready";
        setCart({ state: "ready", root, manifest });
        log("ok", "Cartouche prête — cliquez sur « Jouer » (ou appuyez sur Entrée) pour lancer le jeu");
        notifyReady(manifest);
        return;
      }
      // Windows (AutoPlay) often opens an Explorer window on the new drive a moment after it was detected and takes the focus:
      // take the front back when the intro starts. Not a full fix, the Windows AutoPlay setting is (see the installation guide).
      showConsole();
      cart.state = "intro";
      setCart({ state: "intro", root, manifest, intro: introPayload(root, manifest) });
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
      if (result.status === "removed") {
        watcher.suppress(cart.root);
        currentCart = null;
        send("cc:integrity", null); send("cc:sync", null);
        log("ok", "Cartouche éjectée par Windows : vous pouvez la retirer en toute sécurité");
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

  /** "Jouer" (window button, tray menu): same path as an automatic start: intro, then cc:launch re-checks integrity and starts the game. */
  function playCurrent() {
    const cart = currentCart;
    if (!canPlay() || !cart.manifest) { log("warn", launching ? "Un jeu est déjà en cours" : "Aucune cartouche prête à jouer"); return; }
    try {
      const intro = introPayload(cart.root, cart.manifest);
      showConsole();
      cart.state = "intro";
      setCart({ state: "intro", root: cart.root, manifest: cart.manifest, intro });
    } catch (e) {
      log("error", e.message);
    }
  }

  ipcMain.handle("cc:settings", () => ({ autoLaunch: settings.autoLaunch !== false }));
  ipcMain.handle("cc:setAutoLaunch", (_e, on) => setAutoLaunch(!!on));
  ipcMain.handle("cc:play", () => playCurrent());
  ipcMain.handle("cc:state", () => store.snapshot());
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
    win.on("session-end", () => { if (process.platform === "win32") autoplay.restore(); }); // logoff or shutdown
    if (app.isPackaged || !process.env.COMPUCART_URL) win.loadFile(path.join(__dirname, "renderer", "index.html"));
    else win.loadURL(process.env.COMPUCART_URL);

    // Re-fit the fullscreen window if a game changed the display resolution.
    screen.on("display-metrics-changed", () => {
      if (alive() && win.isVisible() && win.isFullScreen()) win.setBounds(screen.getDisplayMatching(win.getBounds()).bounds);
    });

    tray = new Tray(nativeImage.createFromPath(icon));
    tray.on("click", showConsole);
    tray.on("double-click", showConsole);
    tray.on("balloon-click", showConsole);
    syncAutoplayAtStartup();
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
  // Put the Windows AutoPlay setting back when Compu-Cart stops (the saved option stays, so the next start applies it again).
  const restoreAutoplay = () => { if (process.platform === "win32") autoplay.restore(); };
  app.on("before-quit", () => { quitting = true; watcher?.stop(); restoreAutoplay(); });
  app.on("window-all-closed", () => app.quit());
}
