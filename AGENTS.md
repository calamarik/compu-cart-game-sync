<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

- Keep the desktop renderer as an offline TanStack Router entry reusing the web console, with relative bundled assets and local fonts; the portable Windows app must not depend on a hosted preview or an SSR server.
- Package Windows releases from a clean staging folder with @electron/packager; include only the desktop runtime, renderer, cartridge tools, and installation guide.
- Build the Windows release with electron/installer/build-windows.sh: packager output wrapped in a per-user NSIS Setup.exe (makensis via nix, exe icon via resedit) because electron-builder and Wine are unusable in this sandbox.
- Cartridge detection is event-driven (WM_DEVICECHANGE via hookWindowMessage, then short rescans); never reintroduce periodic drive polling on Windows, and never scan a root after safe eject until a new arrival (scanning would remount it).
- Safe eject runs electron/eject.ps1 through powershell -EncodedCommand (flush, lock, dismount, CM_Request_Device_Eject) so file execution policy does not block it; keep the C# compatible with C# 5 (Windows PowerShell 5.1 Add-Type).
- Autostart is owned by Electron setLoginItemSettings (value name "Compu-Cart", --background); the installer toggles it by running the exe with --configure-only --autostart=on|off rather than writing the Run key itself.
