; Octopolis installer hooks.

; Before uninstalling, give folders and Win+E back to File Explorer if
; "Use Octopolis instead of File Explorer" was on. Only Octopolis's own
; per-user entries are removed; another tool's Win+E override is kept.
; An update also runs the old uninstaller (UpdateMode 1): the entries stay
; then, since the new version keeps using them.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
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
