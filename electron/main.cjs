const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, powerMonitor } = require("electron");
const path = require("path");
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

  const canEject = () => currentCart && !launching && !currentCart.ejecting && ["ready", "choose", "intro", "corrupt", "error"].includes(currentCart.state);
  const canPlay = () => currentCart && !launching && !currentCart.ejecting && ["ready", "choose"].includes(currentCart.state);

  /** What the window gets for a cartridge: titles only, never the checksums. `game` is the game being checked or played. */
  const view = (cart, state = cart.state) => ({
    state,
    root: cart.root,
    title: cart.title,
    games: cart.games?.map(({ id, title }) => ({ id, title })),
    game: cart.game && { id: cart.game.id, title: cart.game.title, executable: cart.game.executable },
  });

  /** Windows balloon when a cartridge found at startup is ready while the console is hidden (background start). */
  function notifyReady(cart) {
    if (process.platform !== "win32" || !tray || (alive() && win.isVisible())) return;
    const action = cart.games.length > 1 ? "puis choisissez un jeu" : "puis sur « Jouer »";
    tray.displayBalloon({ title: "Cartouche prête", content: `${cart.title} est prête. Cliquez ici, ${action}.`, iconType: "info" });
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
    const games = currentCart?.games || [];
    const play = games.length > 1
      ? { label: "▶ Jouer", enabled: !!canPlay(), submenu: games.map((g) => ({ label: g.title, click: () => playCurrent(g.id) })) }
      : { label: games[0] ? `▶ Jouer à ${games[0].title}` : "▶ Jouer", enabled: !!canPlay(), click: () => playCurrent() };
    tray.setToolTip(currentCart ? `Compu-Cart — ${currentCart.title || currentCart.root}` : "Compu-Cart — en attente de cartouche");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Afficher Compu-Cart", click: showConsole },
      play,
      { label: currentCart ? `Éjecter la cartouche (${currentCart.root})` : "Éjecter la cartouche", enabled: !!canEject(), click: () => ejectCurrent() },
      { type: "separator" },
      { label: "Démarrer avec Windows", type: "checkbox", checked: autostartEnabled(), click: (item) => { setAutostart(item.checked); refreshTray(); } },
      { label: "Lancer le jeu automatiquement au branchement", type: "checkbox", checked: settings.autoLaunch !== false, click: (item) => setAutoLaunch(item.checked) },
      ...(process.platform === "win32" ? [{ label: "Désactiver l'exécution automatique de Windows pendant que Compu-Cart tourne", type: "checkbox", checked: !!settings.disableAutoplay, click: (item) => setAutoplayOption(item.checked) }] : []),
      { type: "separator" },
      { label: running ? "Quitter (jeu en cours…)" : "Quitter", enabled: !running, click: () => { quitting = true; app.quit(); } },
    ]));
  }

  /**
   * Checks one game (SHA-256 of the listed files) and syncs its saves. Resolves "ok", "corrupt" (a listed file changed) or
   * "gone" (the cartridge left meanwhile); the caller decides what the console shows next.
   * steps: false when the intro is already on screen, so the console state must not move (it would hide the intro).
   */
  async function prepareGame(cart, game, { steps = true } = {}) {
    const { root } = cart;
    const integrity = await core.verifyIntegrity(root, game);
    if (currentCart !== cart) return "gone";
    send("cc:integrity", integrity);
    if (!integrity.ok) {
      log("error", `${game.title} : intégrité compromise — lancement bloqué`);
      return "corrupt";
    }
    log("ok", `${game.title} : intégrité vérifiée`);
    if (steps) { cart.state = "syncing"; setCart(view(cart, "syncing")); }
    const sync = await core.syncSaves(root, game, app.getPath("appData"));
    if (currentCart !== cart) return "gone";
    send("cc:sync", sync);
    log("ok", `Sauvegardes synchronisées (${sync.plan.filter((p) => p.action !== "skip").length} fichier(s))`);
    return "ok";
  }

  /**
   * reason "startup": cartridge already there at launch (stops on "Prête"); "device": plugged while running (intro, then the game starts by itself;
   * with several games the intro shows the cartridge title and the list, state "choose", and the picked game starts).
   * A single-game cartridge is checked and synced right away. With several games nothing is read beyond the manifests here:
   * the game the player picks is checked and synced when it is launched (startGame), so a big compilation does not delay the menu.
   */
  async function handleInsert(root, reason = "device") {
    if (currentCart) { log("warn", `Une cartouche est déjà active — ${root} ignoré`); return; }
    const cart = { root, state: "verifying" };
    currentCart = cart;
    // Only a plug-in event brings the console to the front by itself; a cartridge found at launch must not take over the screen.
    if (reason === "device" && !win.isVisible()) { autoShown = true; showConsole(); }
    try {
      log("info", reason === "device" ? `Cartouche détectée sur ${root}` : `Cartouche déjà présente sur ${root}`);
      const cartridge = await core.readCartridge(root);
      if (currentCart !== cart) return;
      cart.title = cartridge.title;
      cart.games = cartridge.games;
      const single = cartridge.games.length === 1;
      if (single) cart.game = cartridge.games[0];
      setCart(view(cart, "verifying"));
      if (single) {
        const result = await prepareGame(cart, cart.game);
        if (result === "corrupt") { cart.state = "corrupt"; return setCart(view(cart, "corrupt")); }
        if (result !== "ok") return;
        cart.prepared = true;
      }
      const next = core.nextStateAfterSync(reason, settings.autoLaunch, cartridge.games.length);
      if (next === "choose") {
        // Several games, plugged in with auto launch on: the intro shows the cartridge title and the list of games; picking one
        // (cc:play) plays the intro again with that game's name and starts it. Nothing is checked or synced before that.
        showConsole();
        cart.state = "choose";
        setCart(view(cart, "choose"));
        log("ok", `${cartridge.title} — ${cartridge.games.length} jeux : choisissez celui à lancer`);
        return;
      }
      if (next === "ready") {
        // Plugged in with auto launch off (or found at launch): show the console, Play / Enter / a game of the list starts it. Found at launch: stay quiet.
        if (reason === "device") showConsole();
        cart.state = "ready";
        setCart(view(cart, "ready"));
        log("ok", single ? "Cartouche prête — cliquez sur « Jouer » (ou appuyez sur Entrée) pour lancer le jeu" : `Cartouche prête — ${cartridge.games.length} jeux : choisissez celui à lancer`);
        notifyReady(cart);
        return;
      }
      // Windows (AutoPlay) often opens an Explorer window on the new drive a moment after it was detected and takes the focus:
      // take the front back when the intro starts. Not a full fix, the Windows AutoPlay setting is (see the installation guide).
      showConsole();
      beginPlay(cart);
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
    if (currentCart === cart) { cart.ejecting = false; cart.state = previous; setCart(view(cart, previous)); }
  }

  /** Intro screen (animation + jingle) and, at the same time, the game start: the intro covers the loading time instead of delaying it. */
  function beginPlay(cart, game = cart.game) {
    cart.game = game;
    cart.state = "intro";
    cart.introAt = Date.now();
    setCart(view(cart, "intro"));
    startGame(cart);
  }

  /** "Jouer" (window button, tray menu, Enter) or a game picked in the list: same path as an automatic start. */
  function playCurrent(gameId) {
    const cart = currentCart;
    if (!canPlay()) { log("warn", launching ? "Un jeu est déjà en cours" : "Aucune cartouche prête à jouer"); return; }
    const game = gameId ? cart.games.find((g) => g.id === gameId) : cart.games.length === 1 ? cart.games[0] : null;
    if (!game) { log("warn", gameId ? `Jeu inconnu sur cette cartouche : ${gameId}` : "Choisissez un jeu dans la liste"); return; }
    try {
      showConsole();
      beginPlay(cart, game);
    } catch (e) {
      log("error", e.message);
    }
  }

  /**
   * Starts cart.game while the intro plays. A single-game cartridge was checked and synced at detection, so only a replay checks it again
   * (files may have changed since); with several games the picked game is checked and synced here, once, while the intro covers it.
   * The console state stays "intro" until the game shows a window (never before the minimum intro time), then becomes "running".
   */
  async function startGame(cart) {
    if (launching) return;
    launching = true;
    refreshTray();
    const { root, game } = cart;
    let windowWatch = null;
    let focusWatch = null;
    try {
      if (!cart.prepared) {
        const result = await prepareGame(cart, game, { steps: false });
        if (result === "gone") return;
        if (result === "corrupt") {
          // One corrupt game must not lock the whole compilation: back to the list, the other games stay playable.
          cart.state = cart.games.length > 1 ? "ready" : "corrupt";
          return setCart(view(cart, cart.state));
        }
      }
      cart.prepared = false;
      log("info", `Lancement de ${game.title} (l'intro couvre le chargement)`);
      // The console stays fullscreen behind the game: resolution changes never reveal the desktop.
      win.setAlwaysOnTop(false);
      let exited = false;
      const gameDone = core.launchGame(root, game, () => {
        windowWatch = core.waitForGameWindow(root);
        windowWatch.done.then(async (why) => {
          if (exited || why === "cancelled" || currentCart !== cart) return;
          const wait = core.introRemaining(cart.introAt, Date.now());
          if (wait) await new Promise((r) => setTimeout(r, wait));
          if (exited || currentCart !== cart) return;
          log("info", why === "window" ? "Jeu affiché" : "Jeu en cours (fenêtre non détectée, fin de l'intro)");
          cart.state = "running";
          setCart(view(cart, "running"));
          // Some games open behind the console (slow start, window recreated when switching to fullscreen): bring them forward for a few seconds.
          focusWatch = core.focusGameWindow(root);
        });
      });
      const code = await gameDone.finally(() => { exited = true; windowWatch?.cancel(); focusWatch?.cancel(); });
      showConsole();
      log("info", `Jeu terminé (code ${code}) — synchronisation retour`);
      if (currentCart !== cart) { log("warn", "Cartouche absente : sauvegardes locales conservées, retour reporté"); return; }
      send("cc:sync", await core.syncSaves(root, game, app.getPath("appData")));
      cart.state = "ready";
      setCart(view(cart, "ready"));
    } catch (e) {
      windowWatch?.cancel();
      focusWatch?.cancel();
      log("error", e.message);
      if (currentCart === cart && cart.state !== "corrupt") { cart.state = "error"; setCart(view(cart, "error")); }
    } finally {
      launching = false;
      refreshTray();
    }
  }

  ipcMain.handle("cc:settings", () => ({ autoLaunch: settings.autoLaunch !== false }));
  ipcMain.handle("cc:setAutoLaunch", (_e, on) => setAutoLaunch(!!on));
  ipcMain.handle("cc:play", (_e, gameId) => playCurrent(typeof gameId === "string" ? gameId : undefined));
  // Escape on the game selection: back to the console (Éjecter, Réduire...), the games stay playable from its list.
  ipcMain.handle("cc:cancel", () => {
    const cart = currentCart;
    if (!cart || cart.state !== "choose" || launching) return;
    cart.state = "ready";
    setCart(view(cart, "ready"));
    log("info", "Choix du jeu fermé — la liste reste dans la console");
  });
  ipcMain.handle("cc:state", () => store.snapshot());
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
