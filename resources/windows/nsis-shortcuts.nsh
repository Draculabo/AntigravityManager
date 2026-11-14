!ifndef BUILD_UNINSTALLER
  Var agmDesktopShortcutChoice
  Var agmDesktopShortcutCheckbox

  !undef isNoDesktopShortcut
  !define isNoDesktopShortcut `"" agmNoDesktopShortcut ""`

  !macro _agmNoDesktopShortcut _a _b _t _f
    StrCmp "$agmDesktopShortcutChoice" "0" `${_t}` 0
    !insertmacro _isNoDesktopShortcut `${_a}` `${_b}` `${_t}` `${_f}`
  !macroend

  !macro customInit
    StrCpy $agmDesktopShortcutChoice "1"
    ${if} ${isNoDesktopShortcut}
      StrCpy $agmDesktopShortcutChoice "0"
    ${endif}
  !macroend

  !macro agmShortcutHeader
    LangString agmShortcutsTitle ${LANG_ENGLISH} "Shortcuts"
    LangString agmShortcutsDescription ${LANG_ENGLISH} "Choose how to access Antigravity Manager."
    LangString agmDesktopShortcutLabel ${LANG_ENGLISH} "Create a desktop shortcut"
    LangString agmShortcutsTitle ${LANG_SIMPCHINESE} "快捷方式"
    LangString agmShortcutsDescription ${LANG_SIMPCHINESE} "选择 Antigravity Manager 的启动入口。"
    LangString agmDesktopShortcutLabel ${LANG_SIMPCHINESE} "创建桌面快捷方式"
    LangString agmShortcutsTitle ${LANG_RUSSIAN} "Ярлыки"
    LangString agmShortcutsDescription ${LANG_RUSSIAN} "Выберите способ запуска Antigravity Manager."
    LangString agmDesktopShortcutLabel ${LANG_RUSSIAN} "Создать ярлык на рабочем столе"
    LangString agmShortcutsTitle ${LANG_VIETNAMESE} "Lối tắt"
    LangString agmShortcutsDescription ${LANG_VIETNAMESE} "Chọn cách mở Antigravity Manager."
    LangString agmDesktopShortcutLabel ${LANG_VIETNAMESE} "Tạo lối tắt trên màn hình nền"
    LangString agmShortcutsTitle ${LANG_FRENCH} "Raccourcis"
    LangString agmShortcutsDescription ${LANG_FRENCH} "Choisissez comment ouvrir Antigravity Manager."
    LangString agmDesktopShortcutLabel ${LANG_FRENCH} "Créer un raccourci sur le bureau"
    LangString agmShortcutsTitle ${LANG_PORTUGUESEBR} "Atalhos"
    LangString agmShortcutsDescription ${LANG_PORTUGUESEBR} "Escolha como abrir o Antigravity Manager."
    LangString agmDesktopShortcutLabel ${LANG_PORTUGUESEBR} "Criar um atalho na área de trabalho"
  !macroend

  !macro customPageAfterChangeDir
    !include nsDialogs.nsh

    Page custom AgmShowShortcutPage

    Function AgmShowShortcutPage
      ${if} ${Silent}
        Abort
      ${endif}
      ${if} ${isUpdated}
        Abort
      ${endif}

      !insertmacro MUI_HEADER_TEXT "$(agmShortcutsTitle)" "$(agmShortcutsDescription)"
      nsDialogs::Create 1018
      Pop $0
      ${if} $0 == error
        Abort
      ${endif}

      ${NSD_CreateCheckbox} 0 0 100% 24u "$(agmDesktopShortcutLabel)"
      Pop $agmDesktopShortcutCheckbox
      ${NSD_SetState} $agmDesktopShortcutCheckbox $agmDesktopShortcutChoice
      ${NSD_OnClick} $agmDesktopShortcutCheckbox AgmDesktopShortcutChanged
      ${StdUtils.TestParameter} $0 "no-desktop-shortcut"
      ${if} $0 == "true"
        EnableWindow $agmDesktopShortcutCheckbox 0
      ${endif}
      nsDialogs::Show
    FunctionEnd

    Function AgmDesktopShortcutChanged
      Pop $0
      ${NSD_GetState} $0 $agmDesktopShortcutChoice
    FunctionEnd
  !macroend
!endif
