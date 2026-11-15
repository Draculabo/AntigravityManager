!include "${__FILEDIR__}\nsis-shortcuts.nsh"
!include "${__FILEDIR__}\nsis-feedback.nsh"

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !insertmacro agmShortcutHeader
    !insertmacro agmFeedbackHeader

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
  Var /GLOBAL agmRecovery

  Call agmOpenInstallerLog
  !insertmacro agmStartStage "check-environment" "$(agmCheck)"

  StrCpy $agmPrevious "0"
  ReadRegStr $agmPath SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $agmPath != ""
    GetFullPathName $agmPath "$agmPath"
    GetFullPathName $0 "$INSTDIR"
    ${If} $agmPath != $0
      !insertmacro agmFinishStage "failed" "$\terror=install-location-mismatch"
      !insertmacro agmEndInstall "failed" "$\terror=install-location-mismatch"
      !insertmacro agmShowFailure "Antigravity Manager is installed at $agmPath.$\r$\nRun setup for that location to upgrade it."
      SetErrorLevel 2
      Quit
    ${EndIf}
    ${If} ${FileExists} "$INSTDIR\*.*"
      StrCpy $agmPrevious "1"
    ${EndIf}
    ${IfNot} ${Silent}
    ${AndIfNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONQUESTION "Install the new version of Antigravity Manager? Your settings will be kept." /SD IDCANCEL IDOK agm_upgrade_confirmed
      !insertmacro agmCancelEnvironmentCheck
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
  agm_upgrade_confirmed:
!macroend

!ifndef BUILD_UNINSTALLER
  !macro agmCancelEnvironmentCheck
    !insertmacro agmFinishStage "cancelled" ""
    !insertmacro agmEndInstall "cancelled" ""
  !macroend

  !macro agmAppStillRunning
    !insertmacro agmFinishStage "failed" "$\terror=app-still-running"
    !insertmacro agmEndInstall "failed" "$\terror=app-still-running"
    SetErrorLevel 2
  !macroend
!endif

!macro agmBeforeInstallFiles
  !insertmacro agmFinishStage "ok" ""
!macroend

!macro agmCheckRegistration
  ClearErrors
  ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $1 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
  ReadRegStr $2 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} ${Errors}
  ${OrIf} $0 != $INSTDIR
  ${OrIf} $1 != "${VERSION}"
  ${OrIf} $2 == ""
    !insertmacro agmLogEvent "registration" "warning" "$\terror=installation-registration-incomplete"
    !insertmacro agmShowWarning "$(agmRegistrationWarning)"
  ${EndIf}
!macroend

!macro agmCheckShortcuts
  ${If} $agmMenuShortcutAttempted != "1"
    !insertmacro agmLogEvent "start-menu-shortcut" "skipped" ""
  ${EndIf}
  ${If} $agmDesktopShortcutAttempted != "1"
    !insertmacro agmLogEvent "desktop-shortcut" "skipped" ""
  ${EndIf}
!macroend

!macro agmObserveShortcut TYPE DESTINATION ATTEMPTED WARNING
  StrCpy ${ATTEMPTED} "1"
  ${If} ${Errors}
  ${OrIfNot} ${FileExists} "${DESTINATION}"
    !insertmacro agmLogEvent "${TYPE}-shortcut" "warning" "$\terror=shortcut-write-failed"
    !insertmacro agmShowWarning "${WARNING}"
  ${Else}
    !insertmacro agmLogEvent "${TYPE}-shortcut" "ok" ""
  ${EndIf}
!macroend

!macro agmFailInstall CODE MESSAGE
  StrCpy $agmFailureCode "${CODE}"
  StrCpy $agmFailure "${MESSAGE}"
  !insertmacro agmFinishStage "failed" "$\terror=${CODE}"
  Goto agm_install_failed
!macroend

!macro agmInstallApplication
  !ifndef ZIP_COMPRESSION
    !error "The Antigravity Manager installer requires checked ZIP extraction"
  !endif

  !insertmacro agmStartStage "prepare-files" "$(agmPrepare)"

  # Check the live root before using it as a rename target or cleanup source.
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i .r0'
  ${If} $0 != -1
    IntOp $1 $0 & 0x400
    ${If} $1 != 0
      !insertmacro agmFailInstall "linked-install-location" "Setup cannot replace a linked installation directory."
    ${EndIf}
  ${EndIf}

  # A sibling workspace keeps both directory renames on the destination volume.
  ${GetParent} "$INSTDIR" $agmPath
  ClearErrors
  GetTempFileName $agmWorkspace "$agmPath"
  ${If} ${Errors}
    StrCpy $agmWorkspace ""
    !insertmacro agmFailInstall "staging-directory-unavailable" "Setup cannot create a staging directory beside the installation. Check access and free disk space."
  ${EndIf}
  Delete "$agmWorkspace"
  System::Call 'kernel32::CreateDirectoryW(w "$agmWorkspace", p 0) i .r0'
  ${If} $0 == 0
    StrCpy $agmWorkspace ""
    !insertmacro agmFailInstall "staging-directory-unavailable" "Setup cannot create a staging directory beside the installation. Check access and free disk space."
  ${EndIf}
  ClearErrors
  SetOutPath "$agmWorkspace\new"
  ${If} ${Errors}
    !insertmacro agmFailInstall "staging-directory-unwritable" "Setup cannot write to the staging directory. Check access and free disk space."
  ${EndIf}

  !ifdef COMPRESS
    SetCompress off
  !endif
  Var /GLOBAL packageArch
  !insertmacro identify_package
  ClearErrors
  !insertmacro compute_files_for_current_arch
  !ifdef COMPRESS
    SetCompress "${COMPRESS}"
  !endif
  ${If} ${Errors}
    !insertmacro agmFailInstall "embedded-archive-unavailable" "Setup could not prepare the application archive. Check access and free disk space."
  ${EndIf}
  !insertmacro agmFinishStage "ok" ""

  !insertmacro agmStartStage "extract-files" "$(agmExtract)"
  nsisunz::Unzip "$PLUGINSDIR\app-$packageArch.zip" "$OUTDIR"
  Pop $0
  ${If} $0 != "success"
    !insertmacro agmFailInstall "extraction-failed" "Setup could not extract or write the new application files. Check access and free disk space."
  ${EndIf}
  !insertmacro agmFinishStage "ok" ""

  !insertmacro agmStartStage "verify-files" "$(agmVerify)"
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
    !insertmacro agmFailInstall "required-files-missing" "Setup could not prepare a complete set of application files."
  ${EndIf}
  !insertmacro agmFinishStage "ok" ""

  !insertmacro agmStartStage "activate-version" "$(agmActivate)"

  SetOutPath "$PLUGINSDIR"
  ClearErrors
  ${If} $agmPrevious == "1"
    Rename "$INSTDIR" "$agmWorkspace\previous"
    ${If} ${Errors}
      !insertmacro agmFailInstall "previous-directory-in-use" "Setup cannot move the existing installation. Check for files in use and try again."
    ${EndIf}
  ${Else}
    # .onInit creates the destination. Only an empty, unregistered directory can be replaced.
    ${If} ${FileExists} "$INSTDIR\*.*"
      RMDir "$INSTDIR"
    ${EndIf}
    ${If} ${Errors}
      !insertmacro agmFailInstall "destination-not-empty" "Setup cannot use this installation directory. Choose an empty directory."
    ${EndIf}
  ${EndIf}

  ClearErrors
  Rename "$agmWorkspace\new" "$INSTDIR"
  ${If} ${Errors}
    !insertmacro agmFinishStage "failed" "$\terror=activation-failed"
    ${If} $agmPrevious == "1"
      !insertmacro agmStartStage "restore-version" "$(agmRestore)"
      ClearErrors
      Rename "$agmWorkspace\previous" "$INSTDIR"
      ${If} ${Errors}
        # Recovery must not remove or overwrite the object that blocked activation.
        !insertmacro agmFinishStage "failed" "$\terror=restore-failed$\trecovery_path=$agmWorkspace\previous"
        !insertmacro agmEndInstall "failed" "$\terror=activation-failed$\trecovery=blocked"
        !insertmacro agmShowFailure "Setup could not activate the new version or restore the previous installation. The previous version is still at:$\r$\n$agmWorkspace\previous"
        SetErrorLevel 2
        Quit
      ${EndIf}
      !insertmacro agmFinishStage "ok" ""
      StrCpy $agmRecovery "restored"
    ${EndIf}
    StrCpy $agmFailureCode "activation-failed"
    StrCpy $agmFailure "Setup could not activate the new application files. Check access and try again."
    Goto agm_install_failed
  ${EndIf}
  !insertmacro agmFinishStage "ok" ""

  !insertmacro agmStartStage "cache-installer" "$(agmCache)"
  SetOutPath "$INSTDIR"
  !insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  ${If} ${Errors}
    !insertmacro agmFinishStage "warning" "$\terror=cache-copy-failed"
    !insertmacro agmShowWarning "$(agmCacheWarning)"
  ${Else}
    !insertmacro agmFinishStage "ok" ""
  ${EndIf}
  !insertmacro agmStartStage "register-installation" "$(agmRegister)"
  StrCpy $agmWarningsBeforeRegistration $agmWarningText
  Goto agm_install_done

  agm_install_failed:
    SetOutPath "$PLUGINSDIR"
    ${If} $agmWorkspace != ""
      Push "$agmWorkspace"
      Call agmRemoveOwnedTree
    ${EndIf}
    ${If} $agmRecovery == "restored"
      StrCpy $agmFailure "$agmFailure$\r$\n$(agmPreviousRestored)"
    ${ElseIf} $agmPrevious == "1"
      StrCpy $agmRecovery "kept"
      StrCpy $agmFailure "$agmFailure$\r$\n$(agmPreviousKept)"
    ${Else}
      StrCpy $agmRecovery "not-needed"
    ${EndIf}
    !insertmacro agmEndInstall "failed" "$\terror=$agmFailureCode$\trecovery=$agmRecovery"
    !insertmacro agmShowStatus "$agmFailure"
    !insertmacro agmShowFailure "$agmFailure"
    SetErrorLevel 2
    Quit

  agm_install_done:
!macroend

!macro customInstall
  ${If} $agmWarningText == $agmWarningsBeforeRegistration
    !insertmacro agmFinishStage "ok" ""
  ${Else}
    !insertmacro agmFinishStage "warning" ""
  ${EndIf}
  !insertmacro agmStartStage "clean-up" "$(agmCleanup)"
  Push "$agmWorkspace"
  Call agmRemoveOwnedTree
  System::Call 'kernel32::GetFileAttributesW(w "$agmWorkspace") i .r0'
  ${If} $0 != -1
    !insertmacro agmFinishStage "warning" "$\terror=staging-cleanup-failed"
    !insertmacro agmShowWarning "$(agmCleanupWarning)"
  ${Else}
    !insertmacro agmFinishStage "ok" ""
  ${EndIf}
  ${If} $agmWarningText == ""
    StrCpy $agmFinishText "$(MUI_TEXT_FINISH_INFO_TEXT)"
    !insertmacro agmShowStatus "$(agmComplete)"
    !insertmacro agmEndInstall "ok" ""
  ${Else}
    StrCpy $agmFinishText "$(agmCompleteWarning)$agmWarningText"
    !insertmacro agmShowStatus "$(agmCompleteWarning)"
    !insertmacro agmEndInstall "warning" ""
  ${EndIf}
!macroend
