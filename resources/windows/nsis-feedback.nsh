!ifndef BUILD_UNINSTALLER
  !include "${__FILEDIR__}\nsis-feedback-languages.nsh"

  Var agmLogPath
  Var agmStage
  Var agmFailureCode
  Var agmFinishText
  Var agmTerminal
  Var agmWarningText
  Var agmWarningsBeforeRegistration
  Var agmMenuShortcutAttempted
  Var agmDesktopShortcutAttempted
  Var agmLogSize

  !macro agmShowWarning TEXT
    !insertmacro agmShowStatus "${TEXT}"
    StrCpy $agmWarningText "$agmWarningText$\r$\n${TEXT}"
  !macroend

  !define MUI_FINISHPAGE_TEXT "$agmFinishText"

  !macro agmLogEvent STAGE RESULT EXTRA
    Push "stage=${STAGE}$\tresult=${RESULT}${EXTRA}"
    Call agmWriteLog
  !macroend

  !macro agmShowStatus TEXT
    ${IfNot} ${Silent}
      SetDetailsPrint both
      DetailPrint "${TEXT}"
      SetDetailsPrint none
    ${EndIf}
  !macroend

  !macro agmStartStage STAGE TEXT
    StrCpy $agmStage "${STAGE}"
    !insertmacro agmShowStatus "${TEXT}"
    !insertmacro agmLogEvent "$agmStage" "started" ""
  !macroend

  !macro agmFinishStage RESULT EXTRA
    !insertmacro agmLogEvent "$agmStage" "${RESULT}" "${EXTRA}"
    StrCpy $agmStage ""
  !macroend

  !macro agmEndInstall RESULT EXTRA
    !insertmacro agmLogEvent "install" "${RESULT}" "${EXTRA}"
    StrCpy $agmTerminal "1"
  !macroend

  !macro agmShowFailure MESSAGE
    ${If} $agmLogPath != ""
      MessageBox MB_OK|MB_ICONSTOP "${MESSAGE}$\r$\n$\r$\n$(agmFailureLog):$\r$\n$agmLogPath" /SD IDOK
    ${Else}
      MessageBox MB_OK|MB_ICONSTOP "${MESSAGE}" /SD IDOK
    ${EndIf}
  !macroend

  !macro agmFeedbackHeader
    ShowInstDetails hide
    !insertmacro agmFeedbackLanguages

    Function .onInstFailed
      ${If} $agmTerminal != "1"
        ${If} $agmStage != ""
          !insertmacro agmFinishStage "failed" "$\terror=installer-aborted"
        ${EndIf}
        !insertmacro agmEndInstall "failed" "$\terror=installer-aborted"
      ${EndIf}
    FunctionEnd

    Function agmWriteLog
      Exch $0
      Push $1
      Push $2
      Push $3
      Push $4
      Push $5
      Push $6
      Push $7
      Push $8
      Push $9
      StrCpy $8 "0"
      ${If} ${Errors}
        StrCpy $8 "1"
      ${EndIf}
      ${If} $agmLogPath != ""
        ClearErrors
        FileOpen $1 "$agmLogPath" a
        ${IfNot} ${Errors}
          FileSeek $1 0 END $9
          StrCpy $agmLogSize $9
          ${If} $agmLogSize < 60000
            ${GetTime} "" "LS" $2 $3 $4 $5 $6 $7 $9
            IntFmt $6 "%02u" $6
            StrCpy $0 "time=$4-$3-$2T$6:$7:$9Z$\t$0$\r$\n"
            ${If} $agmLogSize == 0
              FileWriteUTF16LE /BOM $1 "$0"
            ${Else}
              FileWriteUTF16LE $1 "$0"
            ${EndIf}
            ${If} ${Errors}
              StrCpy $agmLogPath ""
            ${EndIf}
          ${EndIf}
          FileClose $1
        ${Else}
          StrCpy $agmLogPath ""
        ${EndIf}
      ${EndIf}
      ${If} $8 == "1"
        SetErrors
      ${Else}
        ClearErrors
      ${EndIf}
      Pop $9
      Pop $8
      Pop $7
      Pop $6
      Pop $5
      Pop $4
      Pop $3
      Pop $2
      Pop $1
      Pop $0
    FunctionEnd

    Function agmPruneInstallerLogs
      ${GetParent} "$agmLogPath" $0
      StrCpy $1 0
      ${DoWhile} $1 < 8
        FindFirst $2 $3 "$0\installer-????-??-??-??????-*.log"
        StrCpy $4 0
        StrCpy $5 ""
        StrCpy $6 0
        ${DoWhile} $3 != ""
          IntOp $6 $6 + 1
          ${If} $6 > 128
            ${ExitDo}
          ${EndIf}
          System::Call 'kernel32::GetFileAttributesW(w "$0\$3") i .r7'
          ${If} $7 != -1
            IntOp $7 $7 & 0x410
            ${If} $7 == 0
              IntOp $4 $4 + 1
              ${If} "$0\$3" != $agmLogPath
                System::Call 'kernel32::lstrcmpW(w r3, w r5) i .r7'
                ${If} $5 == ""
                ${OrIf} $7 < 0
                  StrCpy $5 $3
                ${EndIf}
              ${EndIf}
            ${EndIf}
          ${EndIf}
          FindNext $2 $3
        ${Loop}
        FindClose $2
        ${If} $4 <= 5
        ${OrIf} $5 == ""
          ${ExitDo}
        ${EndIf}
        ClearErrors
        Delete "$0\$5"
        ${If} ${Errors}
          ${ExitDo}
        ${EndIf}
        IntOp $1 $1 + 1
      ${Loop}
    FunctionEnd

    Function agmOpenInstallerLog
      ExpandEnvStrings $0 "%USERPROFILE%"
      ${If} $0 == ""
        Return
      ${EndIf}
      StrCpy $0 "$0\.antigravity-agent"
      CreateDirectory "$0"

      ${GetTime} "" "LS" $1 $2 $4 $5 $6 $7 $8
      IntFmt $6 "%02u" $6
      StrCpy $agmLogPath "$0\installer-$4-$2-$1-$6$7$8-"
      ClearErrors
      GetTempFileName $1 "$0"
      ${If} ${Errors}
        StrCpy $agmLogPath ""
        Return
      ${EndIf}
      ${GetFileName} "$1" $2
      StrCpy $2 $2 -4
      StrCpy $agmLogPath "$agmLogPath$2.log"
      ClearErrors
      Rename "$1" "$agmLogPath"
      ${If} ${Errors}
        Delete "$1"
        StrCpy $agmLogPath ""
        ClearErrors
        Return
      ${EndIf}

      !ifdef APP_ARM64
        StrCpy $0 "arm64"
      !else
        StrCpy $0 "x64"
      !endif
      StrCpy $1 "interactive"
      ${If} ${isUpdated}
        StrCpy $1 "update"
      ${ElseIf} ${Silent}
        StrCpy $1 "silent"
      ${EndIf}
      Push "version=${VERSION}$\tarch=$0$\tmode=$1"
      Call agmWriteLog
      ${If} $agmLogPath != ""
        Call agmPruneInstallerLogs
      ${EndIf}
      ClearErrors
    FunctionEnd
  !macroend
!endif
