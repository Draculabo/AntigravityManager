export interface ActivatableWindow {
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  isVisible: () => boolean;
  show: () => void;
  focus: () => void;
}

/**
 * Restores and focuses an existing window if it is not destroyed.
 * Handles restoring from minimized state and showing from hidden state.
 *
 * @returns true if the window was restored and focused, false if the window was destroyed.
 */
export function restoreExistingWindow(window: ActivatableWindow): boolean {
  if (window.isDestroyed()) {
    return false;
  }

  if (window.isMinimized()) {
    window.restore();
  }

  if (!window.isVisible()) {
    window.show();
  }

  window.focus();
  return true;
}
