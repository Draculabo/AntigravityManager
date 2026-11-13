import { BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { IPC_CHANNELS } from '@/shared/constants';
import type { DesktopZoomCommand } from '../desktop-appearance';

export function installDesktopMenu(): void {
  const zoomItem = (
    role: 'zoomIn' | 'zoomOut' | 'resetZoom',
    command: DesktopZoomCommand,
  ): MenuItemConstructorOptions => ({
    label: Menu.buildFromTemplate([{ role }]).items[0].label,
    click: () => {
      BrowserWindow.getFocusedWindow()?.webContents.send(
        IPC_CHANNELS.DESKTOP_ZOOM_COMMAND,
        command,
      );
    },
  });
  const template: MenuItemConstructorOptions[] = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      role: 'viewMenu',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        zoomItem('resetZoom', 'reset'),
        zoomItem('zoomIn', 'in'),
        zoomItem('zoomOut', 'out'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Learn More', click: () => void shell.openExternal('https://electronjs.org') },
      ],
    },
  ];
  if (process.platform === 'darwin') {
    template.unshift({ role: 'appMenu' });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
