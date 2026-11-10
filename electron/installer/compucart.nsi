; Compu-Cart per-user installer (no admin rights). Built by build-windows.sh.
; Required defines: SRC (packaged app folder), OUTFILE, VERSION, ICON, UNINSTALL_LIST.
Unicode true
ManifestDPIAware true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "Sections.nsh"
!include "FileFunc.nsh"

!define APP "Compu-Cart"
!define EXE "Compu-Cart.exe"
!define UNINSTALLER "Desinstaller-Compu-Cart.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\CompuCart"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

Name "${APP}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Compu-Cart"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "Compu-Cart ${VERSION}"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Installation de Compu-Cart ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "Compu-Cart détecte vos cartouches de jeu (clés USB), vérifie leur intégrité, synchronise les sauvegardes puis lance le jeu en plein écran.$\r$\n$\r$\nL'installation se fait pour votre compte Windows uniquement et ne demande pas de droits administrateur.$\r$\n$\r$\nSi Compu-Cart est ouvert, il sera fermé pendant l'installation : terminez d'abord votre partie."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Lancer Compu-Cart maintenant"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\INSTALLATION.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Ouvrir le guide d'utilisation"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "French"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=${LANG_FRENCH} "ProductName" "Compu-Cart"
VIAddVersionKey /LANG=${LANG_FRENCH} "FileDescription" "Installation de Compu-Cart"
VIAddVersionKey /LANG=${LANG_FRENCH} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_FRENCH} "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_FRENCH} "CompanyName" "Compu-Cart"
VIAddVersionKey /LANG=${LANG_FRENCH} "LegalCopyright" ""

Section "Compu-Cart (requis)" SecCore
  SectionIn RO
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  Sleep 1000
  SetOutPath "$INSTDIR"
  ; Upgrade: replace the previous application files only (saves live elsewhere).
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  File /r "${SRC}\*.*"
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"

  CreateDirectory "$SMPROGRAMS\Compu-Cart"
  CreateShortCut "$SMPROGRAMS\Compu-Cart\Compu-Cart.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  CreateShortCut "$SMPROGRAMS\Compu-Cart\Guide Compu-Cart.lnk" "$INSTDIR\INSTALLATION.txt"
  CreateShortCut "$SMPROGRAMS\Compu-Cart\Désinstaller Compu-Cart.lnk" "$INSTDIR\${UNINSTALLER}"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Compu-Cart"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Compu-Cart"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER}"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER}" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Démarrer avec Windows (en arrière-plan)" SecAuto
  ExecWait '"$INSTDIR\${EXE}" --configure-only --autostart=on'
SectionEnd

Section /o "Raccourci sur le Bureau" SecDesktop
  CreateShortCut "$DESKTOP\Compu-Cart.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
SectionEnd

Section "-AutostartOff"
  ${IfNot} ${SectionIsSelected} ${SecAuto}
    ExecWait '"$INSTDIR\${EXE}" --configure-only --autostart=off'
  ${EndIf}
  ${IfNot} ${SectionIsSelected} ${SecDesktop}
    Delete "$DESKTOP\Compu-Cart.lnk"
  ${EndIf}
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore} "Le programme Compu-Cart, l'outil de préparation de cartouche et le guide."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecAuto} "Compu-Cart démarre discrètement à l'ouverture de session et attend une cartouche depuis la zone de notification."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Ajoute une icône Compu-Cart sur le Bureau."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  Sleep 1000
  ExecWait '"$INSTDIR\${EXE}" --configure-only --autostart=off'
  ExecWait '"$INSTDIR\${EXE}" --configure-only --autoplay=restore'
  DeleteRegValue HKCU "${RUN_KEY}" "Compu-Cart"
  Delete "$DESKTOP\Compu-Cart.lnk"
  RMDir /r "$SMPROGRAMS\Compu-Cart"
  ; Only the files this installer put there; game saves in %APPDATA%\CompuCart are kept.
  !include "${UNINSTALL_LIST}"
  Delete "$INSTDIR\${UNINSTALLER}"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
