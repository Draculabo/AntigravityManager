!include "${__FILEDIR__}\nsis-shortcuts.nsh"

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !insertmacro agmShortcutHeader

    Function agmRemoveOwnedTree
      Exch $0
      Push $1
      Push $2
      Push $3
      System::Call 'kernel32::GetFileAttributesW(w r0) i .r3'
      ${If} $3 != -1
        IntOp $1 $3 & 0x10
        ${If} $1 == 0
          Delete "$0"
        ${Else}
          # NSIS recursive removal follows junctions. Remove linked directories without entering them.
          IntOp $1 $3 & 0x400
          ${If} $1 == 0
            FindFirst $1 $2 "$0\*.*"
            ${While} $2 != ""
              ${If} $2 != "."
              ${AndIf} $2 != ".."
                Push "$0\$2"
                Call agmRemoveOwnedTree
              ${EndIf}
              FindNext $1 $2
            ${EndWhile}
            FindClose $1
          ${EndIf}
          RMDir "$0"
        ${EndIf}
      ${EndIf}
      Pop $3
      Pop $2
      Pop $1
      Pop $0
    FunctionEnd
  !endif
!macroend

!macro agmConfirmUpgrade
  Var /GLOBAL agmPrevious
  Var /GLOBAL agmWorkspace
  Var /GLOBAL agmFailure
  Var /GLOBAL agmPath

  StrCpy $agmPrevious "0"
  ReadRegStr $agmPath SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $agmPath != ""
    GetFullPathName $agmPath "$agmPath"
    GetFullPathName $0 "$INSTDIR"
    ${If} $agmPath != $0
      MessageBox MB_OK|MB_ICONSTOP "Antigravity Manager is installed at $agmPath.$\r$\nRun setup for that location to upgrade it." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    ${If} ${FileExists} "$INSTDIR\*.*"
      StrCpy $agmPrevious "1"
    ${EndIf}
    ${IfNot} ${Silent}
    ${AndIfNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONQUESTION "Install the new version of Antigravity Manager? Your settings will be kept." /SD IDCANCEL IDOK agm_upgrade_confirmed
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
  agm_upgrade_confirmed:
!macroend

!macro agmFailInstall MESSAGE
  StrCpy $agmFailure "${MESSAGE}"
  Goto agm_install_failed
!macroend

!macro agmInstallApplication
  !ifndef ZIP_COMPRESSION
    !error "The Antigravity Manager installer requires checked ZIP extraction"
  !endif

  # Check the live root before using it as a rename target or cleanup source.
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i .r0'
  ${If} $0 != -1
    IntOp $1 $0 & 0x400
    ${If} $1 != 0
      !insertmacro agmFailInstall "Setup cannot replace a linked installation directory."
    ${EndIf}
  ${EndIf}

  # A sibling workspace keeps both directory renames on the destination volume.
  ${GetParent} "$INSTDIR" $agmPath
  ClearErrors
  GetTempFileName $agmWorkspace "$agmPath"
  ${If} ${Errors}
    StrCpy $agmWorkspace ""
    !insertmacro agmFailInstall "Setup cannot create a staging directory beside the installation. Check access and free disk space."
  ${EndIf}
  Delete "$agmWorkspace"
  System::Call 'kernel32::CreateDirectoryW(w "$agmWorkspace", p 0) i .r0'
  ${If} $0 == 0
    StrCpy $agmWorkspace ""
    !insertmacro agmFailInstall "Setup cannot create a staging directory beside the installation. Check access and free disk space."
  ${EndIf}
  ClearErrors
  SetOutPath "$agmWorkspace\new"
  ${If} ${Errors}
    !insertmacro agmFailInstall "Setup cannot write to the staging directory. Check access and free disk space."
  ${EndIf}

  !ifdef COMPRESS
    SetCompress off
  !endif
  Var /GLOBAL packageArch
  !insertmacro identify_package
  !insertmacro compute_files_for_current_arch
  !ifdef COMPRESS
    SetCompress "${COMPRESS}"
  !endif
  nsisunz::Unzip "$PLUGINSDIR\app-$packageArch.zip" "$OUTDIR"
  Pop $0
  ${If} $0 != "success"
    !insertmacro agmFailInstall "Setup could not extract or write the new application files. Check access and free disk space."
  ${EndIf}
  ClearErrors
  !ifdef UNINSTALLER_ICON
    File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"
  !endif
  File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
  ${If} ${Errors}
  ${OrIfNot} ${FileExists} "$OUTDIR\${APP_EXECUTABLE_FILENAME}"
  ${OrIfNot} ${FileExists} "$OUTDIR\resources\app.asar"
  ${OrIfNot} ${FileExists} "$OUTDIR\resources\app-update.yml"
  ${OrIfNot} ${FileExists} "$OUTDIR\${UNINSTALL_FILENAME}"
    !insertmacro agmFailInstall "Setup could not prepare a complete set of application files."
  ${EndIf}

  SetOutPath "$PLUGINSDIR"
  ClearErrors
  ${If} $agmPrevious == "1"
    Rename "$INSTDIR" "$agmWorkspace\previous"
    ${If} ${Errors}
      !insertmacro agmFailInstall "Setup cannot move the existing installation. Check for files in use and try again."
    ${EndIf}
  ${Else}
    # .onInit creates the destination. Only an empty, unregistered directory can be replaced.
    ${If} ${FileExists} "$INSTDIR\*.*"
      RMDir "$INSTDIR"
    ${EndIf}
    ${If} ${Errors}
      !insertmacro agmFailInstall "Setup cannot use this installation directory. Choose an empty directory."
    ${EndIf}
  ${EndIf}

  ClearErrors
  Rename "$agmWorkspace\new" "$INSTDIR"
  ${If} ${Errors}
    ${If} $agmPrevious == "1"
      ClearErrors
      Rename "$agmWorkspace\previous" "$INSTDIR"
      ${If} ${Errors}
        # Recovery must not remove or overwrite the object that blocked activation.
        DetailPrint "Previous installation saved at $agmWorkspace\previous"
        MessageBox MB_OK|MB_ICONSTOP "Setup could not activate the new version or restore the previous installation. The previous version is still at:$\r$\n$agmWorkspace\previous" /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
    !insertmacro agmFailInstall "Setup could not activate the new application files. Check access and try again."
  ${EndIf}

  SetOutPath "$INSTDIR"
  !insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  Goto agm_install_done

  agm_install_failed:
    SetOutPath "$PLUGINSDIR"
    ${If} $agmWorkspace != ""
      Push "$agmWorkspace"
      Call agmRemoveOwnedTree
    ${EndIf}
    ${If} $agmPrevious == "1"
      StrCpy $agmFailure "$agmFailure$\r$\nThe previous installation was kept."
    ${EndIf}
    DetailPrint "$agmFailure"
    MessageBox MB_OK|MB_ICONSTOP "$agmFailure" /SD IDOK
    SetErrorLevel 2
    Quit

  agm_install_done:
!macroend

!macro customInstall
  Push "$agmWorkspace"
  Call agmRemoveOwnedTree
  ${If} ${FileExists} "$agmWorkspace\*.*"
    DetailPrint "Setup could not remove the staging directory: $agmWorkspace"
  ${EndIf}
!macroend
