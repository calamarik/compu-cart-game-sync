# Compu-Cart Windows delivery
- [x] Bundle the existing console for offline Windows use.
- [x] Package the Windows x64 portable runtime and cartridge tools.
- [x] Include French installation instructions and validate the ZIP (offline window and file checks passed; real Windows hardware testing unavailable).

# Compu-Cart 1.1
- [x] Safe eject button (flush, lock, dismount, Windows device eject) in the console and tray.
- [x] Event-driven cartridge detection (Windows device-change messages) instead of polling drive letters.
- [x] Background mode in the notification area, start with Windows, real Setup.exe installer + uninstaller.
- [x] Borderless fullscreen console that stays behind the game to hide the desktop.
- [x] Tests, updated French guide, build and inspect the installer (real Windows hardware testing unavailable).

# Compu-Cart 1.2
- [x] Forced detection at launch: scan now, then after 2, 6 and 15 seconds (Windows may still be mounting the drive at logon).
- [x] A cartridge already present at launch stops on "Prête" instead of starting the game; only a cartridge plugged in while running auto-plays.
- [x] "▶ Jouer" button on the console and in the tray menu (also used after leaving a game).
- [x] "Cartouche prête" notification balloon when starting in the background (click opens the console).
- [x] The console asks the main process for the current state when it opens, so a cartridge detected before the window was listening is displayed.
- [x] Tests and French guide updated, installer version set to 1.2.0 (build-windows.sh).
- [x] Optional tray checkbox "Désactiver l'exécution automatique de Windows pendant que Compu-Cart tourne" (off by default): stops Windows opening Explorer on the cartridge and stealing the focus; previous value saved and restored on quit / next start after a crash / uninstall. Not yet verified on Windows: whether the change applies immediately.
- [x] The console takes the front back when the intro starts (partial protection when the option is off).
- [ ] Build Compu-Cart-Setup-1.2.0.exe (needs makensis, not available in the environment where this was written).
- [ ] Test on real Windows hardware: USB already plugged at logon, plugged while running, background balloon, Play after leaving a game.
