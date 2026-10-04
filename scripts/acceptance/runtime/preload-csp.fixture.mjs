import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow } from 'electron';

const [directory, resultPath, policyTiming] = process.argv.slice(2);
app.setPath('userData', path.join(directory, 'profile'));
const watchdog = setTimeout(() => app.exit(1), 20000);
watchdog.unref();

app.whenReady().then(async () => {
  let window;
  try {
    window = new BrowserWindow({
      show: false,
      // Match the main window: isolated worlds do not reproduce its CSP compilation failure.
      webPreferences: {
        preload: path.join(directory, 'build', 'preload.js'),
        contextIsolation: false,
        nodeIntegration: true,
        nodeIntegrationInSubFrames: false,
        sandbox: false,
        webSecurity: true,
      },
    });
    const errors = [];
    window.webContents.on('console-message', (event) => {
      if (/EvalError|unsafe-eval/.test(event.message)) {
        errors.push({ kind: 'dynamic-compilation-blocked', source: path.basename(event.sourceId) });
      }
    });
    window.webContents.on('preload-error', () => {
      errors.push({ kind: 'preload-error' });
    });
    await window.loadFile(path.join(directory, 'index.html'));
    const blocked = await window.webContents.executeJavaScript(`
      (() => {
        try { new Function('return 1')(); return false; }
        catch (error) { return error.name === 'EvalError'; }
      })()
    `);
    assert.equal(blocked, true, 'The renderer must enforce the no-eval policy');
    errors.length = 0;

    // The public preload callback receives the same channel used by the production publisher.
    const channel = 'traffic-audit-event';
    window.webContents.send(channel, { id: 'invalid', kind: 'unknown', timestamp: -1 });
    const expected = Array.from({ length: 100 }, (_, index) => ({
      id: `synthetic-${index}`,
      kind: index % 2 === 0 ? 'created' : 'updated',
      timestamp: index,
      trafficClass: 'model',
    }));
    for (const event of expected) {
      window.webContents.send(channel, event);
    }
    const deadline = Date.now() + 3000;
    let received = [];
    while (Date.now() < deadline) {
      received = await window.webContents.executeJavaScript('window.receivedEvents');
      if (received.length === expected.length || errors.length >= expected.length) {
        break;
      }
      await delay(20);
    }
    const visibleCount = await window.webContents.executeJavaScript(
      'document.getElementById("count").textContent',
    );
    await window.webContents.executeJavaScript('window.unsubscribeTraffic()');
    window.webContents.send(channel, { ...expected[0], id: 'after-unsubscribe' });
    await delay(100);
    const afterUnsubscribe = await window.webContents.executeJavaScript('window.receivedEvents');
    const result = {
      electron: process.versions.electron,
      platform: process.platform,
      policyTiming,
      sandbox: window.webContents.getLastWebPreferences().sandbox,
      contextIsolation: window.webContents.getLastWebPreferences().contextIsolation,
      nodeIntegration: window.webContents.getLastWebPreferences().nodeIntegration,
      webSecurity: window.webContents.getLastWebPreferences().webSecurity,
      evalBlocked: blocked,
      expectedEvents: expected.length,
      receivedEvents: received.length,
      exactEventSequence: JSON.stringify(received) === JSON.stringify(expected),
      visibleCount,
      invalidEventIgnored: !received.some((event) => event.id === 'invalid'),
      unsubscribeWorks: JSON.stringify(afterUnsubscribe) === JSON.stringify(received),
      preloadErrors: errors,
    };
    writeFileSync(resultPath, JSON.stringify(result, null, 2));
    window.destroy();
    app.quit();
  } catch (error) {
    console.error(error.message);
    window?.destroy();
    app.exit(1);
  }
});
