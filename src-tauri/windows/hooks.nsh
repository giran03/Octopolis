; Octopolis installer hooks.

; Before uninstalling, give folders and Win+E back to File Explorer if
; "Use Octopolis instead of File Explorer" was on. Only Octopolis's own
; per-user entries are removed; another tool's Win+E override is kept.
!macro NSIS_HOOK_PREUNINSTALL
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
!macroend
