; Keep updates in the installation directory recorded by the Windows uninstaller.
; This also covers installations created by older package versions.
!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode = 1
    ReadRegStr $0 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}" "InstallLocation"
    StrCmp $0 "" done
    ; Older NSIS bundles stored InstallLocation with surrounding quotes.
    StrCpy $1 $0 1
    StrCmp $1 '"' 0 set_location
    StrCpy $0 $0 "" 1
    StrCpy $0 $0 -1
  set_location:
    StrCpy $INSTDIR $0
  done:
  ${EndIf}
!macroend
