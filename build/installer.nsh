; Only NSIS installations receive this marker. The portable executable and the
; unpacked build share the ASAR but must never start an in-place installer.
!macro customCheckAppRunning
  ; Upstream may stop processes by executable name. Only wait for the file
  ; in THIS installation to be released; never terminate another instance.
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Push $0
    Push $1
    StrCpy $1 0
    ${Do}
      ; GENERIC_WRITE, no sharing, OPEN_EXISTING. No data is written.
      System::Call 'kernel32::CreateFileW(w "$INSTDIR\${APP_EXECUTABLE_FILENAME}", i 0x40000000, i 0, p 0, i 3, i 0, p 0) p.r0'
      ${If} $0 != -1
        System::Call 'kernel32::CloseHandle(p r0)'
        ${ExitDo}
      ${EndIf}
      IntOp $1 $1 + 1
      ${If} $1 >= 40
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "请保存稿件并退出 DeepWriter，再重试。 / Close DeepWriter and retry." /SD IDCANCEL IDRETRY +3
        SetErrorLevel 2
        Quit
        StrCpy $1 0
      ${EndIf}
      Sleep 250
    ${Loop}
    Pop $1
    Pop $0
  ${EndIf}
!macroend

!macro customInstall
  Push $0
  FileOpen $0 "$INSTDIR\deepwriter-install.channel" w
  FileWrite $0 "nsis"
  FileClose $0
  Pop $0
!macroend

!macro customUnInstall
  Delete "$INSTDIR\deepwriter-install.channel"
!macroend
