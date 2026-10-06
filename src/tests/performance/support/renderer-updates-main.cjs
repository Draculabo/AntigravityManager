async function openProfilingWindow() {
  const { app, BrowserWindow } = await import('electron');
  app.on('window-all-closed', () => app.quit());
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1500,
    height: 1000,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await window.loadURL(process.env.AGM_RENDERER_PROFILE_URL);
}

void openProfilingWindow();
