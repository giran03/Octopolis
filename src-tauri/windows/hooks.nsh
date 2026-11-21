; Octopolis installer hooks.

; The Win+E helper (octopolis-keys.exe, WE-01) is built by Octopolis Build.bat
; ("cargo build --release -p octopolis-keys") and installed beside Octopolis.exe.
; The path is fixed here, while this file is being included.
!define OCTO_KEYS_SRC "${__FILEDIR__}\..\..\target\release\octopolis-keys.exe"

; Installing or updating: stop this copy's running helper so its file can be replaced.
!macro NSIS_HOOK_PREINSTALL
  ${If} ${FileExists} "$INSTDIR\octopolis-keys.exe"
    ExecWait '"$INSTDIR\octopolis-keys.exe" --stop'
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !if /FileExists "${OCTO_KEYS_SRC}"
    SetOutPath "$INSTDIR"
    File "/oname=octopolis-keys.exe" "${OCTO_KEYS_SRC}"
  !else
    !error "octopolis-keys.exe isn't built. Run: cargo build --release -p octopolis-keys (Octopolis Build.bat does this)"
  !endif
  ; Started only when its Run value names it: the mode points at this copy and
  ; "Win+E opens Octopolis" is on. It checks that again itself before catching.
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OctopolisKeys"
  ${If} $0 == '"$INSTDIR\octopolis-keys.exe"'
    Exec '"$INSTDIR\octopolis-keys.exe"'
  ${EndIf}
!macroend

; After uninstalling: the helper isn't one of the files Tauri tracks, so it is removed here.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    Delete "$INSTDIR\octopolis-keys.exe"
  ${EndIf}
!macroend

; Before uninstalling, give folders and Win+E back to File Explorer if
; "Use Octopolis instead of File Explorer" was on. Octopolis.exe --restore-explorer
; goes first: it puts back what each value held before, using the record Octopolis
; kept, and leaves values another tool wrote. The direct deletes after it are only
; a fallback, run when Octopolis.exe is missing or --restore-explorer did not exit 0;
; another tool's Win+E override is kept.
; An update also runs the old uninstaller (UpdateMode 1): the entries stay
; then, since the new version keeps using them.
!macro NSIS_HOOK_PREUNINSTALL
  ; This copy's Win+E helper stops first (another copy's is left alone), so nothing
  ; catches Win+E for a copy that is going away and its file can be removed.
  ${If} ${FileExists} "$INSTDIR\octopolis-keys.exe"
    ExecWait '"$INSTDIR\octopolis-keys.exe" --stop'
  ${EndIf}
  ${If} $UpdateMode <> 1
    ; 1 (run the fallback) unless --restore-explorer starts and exits 0. ExecWait
    ; sets the error flag when it can't start the exe and then leaves $0 undefined,
    ; so the flag is checked directly.
    StrCpy $0 1
    ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ClearErrors
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --restore-explorer' $0
      ${If} ${Errors}
        StrCpy $0 1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $UpdateMode <> 1
  ${AndIf} $0 <> 0
    DeleteRegKey HKCU "Software\Classes\Directory\shell\openinoctopolis"
    DeleteRegKey HKCU "Software\Classes\Drive\shell\openinoctopolis"
    ; The opt-in "Open in Octopolis" menu entry.
    DeleteRegKey HKCU "Software\Classes\Directory\shell\octopolis.open"
    DeleteRegKey HKCU "Software\Classes\Drive\shell\octopolis.open"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\octopolis.open"
    ReadRegStr $0 HKCU "Software\Classes\Directory\shell" ""
    StrCmp $0 "openinoctopolis" 0 +2
      DeleteRegValue HKCU "Software\Classes\Directory\shell" ""
    ReadRegStr $0 HKCU "Software\Classes\Drive\shell" ""
    StrCmp $0 "openinoctopolis" 0 +2
      DeleteRegValue HKCU "Software\Classes\Drive\shell" ""
    ; StrCmp ignores case, so a differently cased install path still matches.
    ReadRegStr $0 HKCU "Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow\command" ""
    StrCmp $0 '"$INSTDIR\${MAINBINARYNAME}.exe" "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"' 0 +2
      DeleteRegKey HKCU "Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}"
    ; The helper's Run value, only when it starts this install's helper.
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OctopolisKeys"
    StrCmp $0 '"$INSTDIR\octopolis-keys.exe"' 0 +2
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OctopolisKeys"
  ${EndIf}

  ; Fonts saved from Google Fonts (Settings > Appearance) live in <app data>\fonts. Ticking "Delete the
  ; application data" removes them with everything else. When it is left unticked, ask, so the user can keep the
  ; fonts or remove just them. A silent uninstall keeps them, and an update never touches them.
  ${If} $UpdateMode <> 1
  ${AndIf} $DeleteAppDataCheckboxState <> 1
    Push $3
    ReadEnvStr $3 APPDATA
    ${If} ${FileExists} "$3\${BUNDLEID}\fonts\*.*"
      MessageBox MB_YESNO|MB_ICONQUESTION "Octopolis saved fonts from Google Fonts on this PC.$\r$\n$\r$\nRemove them as well?" /SD IDNO IDNO +2
      RMDir /r "$3\${BUNDLEID}\fonts"
    ${EndIf}
    Pop $3
  ${EndIf}

  ; "Delete the application data" removes the app's own folders afterwards, but not a
  ; cache folder the user moved elsewhere (Settings > Advanced). That folder was the
  ; user's choice and may hold other things, so only Octopolis's files go, and the
  ; folders themselves only if nothing else is left in them.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    Push $1
    Push $2
    Push $3
    ; Read from the environment so the shell context (per-user or per-machine) does not matter.
    ReadEnvStr $3 APPDATA
    ClearErrors
    FileOpen $1 "$3\${BUNDLEID}\cache-location.txt" r
    ${IfNot} ${Errors}
      FileRead $1 $2
      FileClose $1
      ; Drop a trailing line break, space or backslash.
      ${Do}
        StrCpy $3 $2 1 -1
        ${If} $3 == "$\r"
        ${OrIf} $3 == "$\n"
        ${OrIf} $3 == " "
        ${OrIf} $3 == "\"
          StrCpy $2 $2 -1
        ${Else}
          ${ExitDo}
        ${EndIf}
      ${Loop}
      ${If} $2 != ""
        Delete "$2\size-cache.json"
        Delete "$2\size-cache.json.tmp"
        Delete "$2\updates\Octopolis*.exe"
        Delete "$2\updates\Octopolis*.part"
        RMDir "$2\updates"
        RMDir "$2"
      ${EndIf}
    ${EndIf}
    Pop $3
    Pop $2
    Pop $1
  ${EndIf}
!macroend
