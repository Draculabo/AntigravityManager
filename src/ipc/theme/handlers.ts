import { os } from "@orpc/server";
import { nativeTheme } from "electron";
import { setThemeModeInputSchema } from "./schemas";

export const getCurrentThemeMode = os.handler(() => {
  return nativeTheme.themeSource;
});

export const toggleThemeMode = os.handler(() => {
  if (nativeTheme.shouldUseDarkColors) {
    nativeTheme.themeSource = "light";
  } else {
    nativeTheme.themeSource = "dark";
  }

  return nativeTheme.shouldUseDarkColors;
});

export const setThemeMode = os
  .input(setThemeModeInputSchema)
  .handler(({ input: mode }) => {
    switch (mode) {
      case "light":
        nativeTheme.themeSource = "light";
        break;
      case "dark":
        nativeTheme.themeSource = "dark";
        break;
      case "system":
        nativeTheme.themeSource = "system";
        break;
    }

    return nativeTheme.themeSource;
  });
