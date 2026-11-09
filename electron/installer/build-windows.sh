#!/usr/bin/env bash
# Builds the Compu-Cart Windows x64 installer (Compu-Cart-Setup-<version>.exe) from Linux.
# Needs: bun, node/npm, nix (for makensis). Tools are installed in $WORK, never in the project.
set -euo pipefail
VERSION="${VERSION:-1.1.0}"
PROJECT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${WORK:-/tmp/ccbuild}"
STAGE="$WORK/stage"
OUT="${OUT:-$WORK/out}"

mkdir -p "$WORK"
cd "$WORK"
if [ ! -d node_modules/@electron/packager ] || [ ! -d node_modules/resedit ]; then
  [ -f package.json ] || echo '{"name":"ccbuild","private":true}' > package.json
  npm install --no-audit --no-fund @electron/packager@18 electron@33 resedit@2 pe-library
fi
ELECTRON_VERSION="$(node -p "require('./node_modules/electron/package.json').version")"

rm -rf "$STAGE" && mkdir -p "$STAGE/app/electron" "$OUT"
(cd "$PROJECT" && COMPUCART_RENDERER_OUT="$STAGE/app/electron/renderer" bunx vite build --config electron/renderer/vite.config.mjs)
cp "$PROJECT"/electron/main.cjs "$PROJECT"/electron/core.cjs "$PROJECT"/electron/preload.cjs "$PROJECT"/electron/eject.ps1 "$STAGE/app/electron/"
cp -r "$PROJECT/electron/assets" "$STAGE/app/electron/"
cat > "$STAGE/app/package.json" <<JSON
{ "name": "compu-cart", "productName": "Compu-Cart", "version": "$VERSION", "description": "Compu-Cart", "main": "electron/main.cjs" }
JSON

npx @electron/packager "$STAGE/app" Compu-Cart --platform=win32 --arch=x64 \
  --electron-version="$ELECTRON_VERSION" --out="$STAGE/pkg" --overwrite --app-version="$VERSION"
APPDIR="$STAGE/pkg/Compu-Cart-win32-x64"
node "$PROJECT/electron/installer/stamp-exe.mjs" "$APPDIR/Compu-Cart.exe" "$PROJECT/electron/assets/icon.ico" "$VERSION" "$WORK/node_modules/resedit"

# Cartridge tools and guide next to the program.
mkdir -p "$APPDIR/outils" "$APPDIR/exemple-cartouche"
cp "$PROJECT/electron/outils/Preparer-Cartouche.ps1" "$APPDIR/outils/"
cp "$PROJECT/electron/compucart.modele.json" "$APPDIR/exemple-cartouche/"
cp "$PROJECT/electron/INSTALLATION.txt" "$APPDIR/INSTALLATION.txt"

# Uninstall list: exactly the top-level entries we ship.
LIST="$STAGE/uninstall-list.nsh"
: > "$LIST"
for entry in "$APPDIR"/*; do
  name="$(basename "$entry")"
  if [ -d "$entry" ]; then echo "RMDir /r \"\$INSTDIR\\$name\"" >> "$LIST"; else echo "Delete \"\$INSTDIR\\$name\"" >> "$LIST"; fi
done

nix run nixpkgs#nsis -- -V2 -INPUTCHARSET UTF8 \
  -DSRC="$APPDIR" -DVERSION="$VERSION" -DICON="$PROJECT/electron/assets/icon.ico" \
  -DUNINSTALL_LIST="$LIST" -DOUTFILE="$OUT/Compu-Cart-Setup-$VERSION.exe" \
  "$PROJECT/electron/installer/compucart.nsi"
ls -la "$OUT"
