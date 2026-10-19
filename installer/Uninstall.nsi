; "Uninstall Photon.exe", placed in the Photon folder and used by Settings > Apps.
; Copies the installer files to a temporary folder and runs them from there, so the
; Photon folder (including this file) can be deleted.

Unicode true
!ifndef VERSION
  !define VERSION "1.0.0"
!endif

!include "x64.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

Name "Photon"
Caption "Remove Photon"
OutFile "..\build\stage\Uninstall Photon.exe"
Icon "assets\photon.ico"
RequestExecutionLevel admin
SilentInstall silent
ManifestDPIAware true
ManifestSupportedOS all

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Photon"
VIAddVersionKey "FileDescription" "Remove Photon"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Photon"
VIAddVersionKey "LegalCopyright" "Photon"

Section
  ${If} ${IsWow64}
    ${DisableX64FSRedirection}
  ${EndIf}

  StrCpy $2 "$TEMP\Photon-Uninstall"
  RMDir /r "$2"
  CreateDirectory "$2"
  CopyFiles /SILENT "$EXEDIR\installer\*.*" "$2"

  ${GetParameters} $0
  StrCpy $3 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$2\setup.ps1" -Uninstall -Payload "$2" $0'

  ; With -Quiet (used by scripts and Settings' quiet uninstall) wait for the result.
  ClearErrors
  ${GetOptions} $0 "-Quiet" $1
  ${IfNot} ${Errors}
    ExecWait $3 $1
    SetErrorLevel $1
  ${Else}
    Exec $3
  ${EndIf}
SectionEnd
