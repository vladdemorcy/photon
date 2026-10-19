; Photon-Setup.exe
; A thin wrapper: asks for admin rights, unpacks Photon to a temporary folder, and runs
; setup.ps1, which shows the themed installer window and does the work.
; Built by installer/build.sh with:  makensis -DVERSION=x.y.z Setup.nsi

Unicode true
!ifndef VERSION
  !define VERSION "1.0.0"
!endif

!include "x64.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

Name "Photon"
Caption "Photon Setup"
OutFile "..\dist\Photon-Setup-${VERSION}.exe"
Icon "assets\photon.ico"
RequestExecutionLevel admin
SilentInstall silent
ManifestDPIAware true
ManifestSupportedOS all
SetCompressor /SOLID lzma
SetCompressorDictSize 32

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Photon"
VIAddVersionKey "FileDescription" "Photon Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Photon"
VIAddVersionKey "LegalCopyright" "Photon"

Section
  ; NSIS is 32-bit. Use the 64-bit PowerShell on 64-bit Windows so Program Files,
  ; the registry and the service all land in the right place.
  ${If} ${IsWow64}
    ${DisableX64FSRedirection}
  ${EndIf}

  InitPluginsDir
  SetOutPath "$PLUGINSDIR\payload"
  File /r "..\build\stage\*.*"

  ; Pass along options such as -Quiet -Port 8787 -ImportFrom "D:\Photon"
  ${GetParameters} $0
  StrCpy $2 "$TEMP\Photon-Setup-error.txt"
  Delete "$2"

  ; Run setup.ps1 inside a small wrapper so that even a failure to start the script
  ; (for example a policy that blocks scripts) is written down instead of lost.
  ExecWait `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& { try { & '$PLUGINSDIR\payload\installer\setup.ps1' -Payload '$PLUGINSDIR\payload' $0; exit $$LASTEXITCODE } catch { ($$_ | Out-String) + [Environment]::NewLine + 'Language mode: ' + $$ExecutionContext.SessionState.LanguageMode | Set-Content -Path '$2'; exit 4 } }"` $1
  SetOutPath "$TEMP"

  ; 0 = done, 1 = install failed and 3 = setup hit an error (both already shown in a window),
  ; 2 = closed by the user. Anything else means PowerShell couldn't run the setup script.
  ClearErrors
  ${GetOptions} $0 "-Quiet" $3
  ${If} ${Errors}
  ${AndIf} $1 != 0
  ${AndIf} $1 != 1
  ${AndIf} $1 != 2
  ${AndIf} $1 != 3
    ${If} ${FileExists} "$2"
      MessageBox MB_YESNO|MB_ICONSTOP "Photon setup couldn't start.$\r$\n$\r$\nThe details are saved in:$\r$\n$2$\r$\n$\r$\nOpen them now?" IDNO done
      ExecShell "open" "notepad.exe" '"$2"'
    ${Else}
      MessageBox MB_ICONSTOP "Photon setup couldn't start (Windows PowerShell returned code $1).$\r$\n$\r$\nMake sure Windows PowerShell is installed and not blocked on this computer."
    ${EndIf}
    done:
  ${EndIf}
  SetErrorLevel $1
SectionEnd
