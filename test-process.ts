
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execAsync = promisify(exec);

function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const version = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return version.includes('microsoft') && version.includes('wsl');
  } catch {
    return false;
  }
}

async function isProcessRunning(): Promise<boolean> {
  try {
    const platform = process.platform;
    let command = '';

    console.log('Platform:', platform);
    console.log('Is WSL:', isWsl());

    if (platform === 'win32' || isWsl()) {
      const cmd = isWsl() ? '/mnt/c/Windows/System32/tasklist.exe' : 'tasklist';
      command = `${cmd} /FI "IMAGENAME eq Antigravity.exe" /NH`;
    } else {
      command = 'pgrep -x Antigravity';
    }

    console.log('Command:', command);
    const { stdout } = await execAsync(command);
    console.log('Stdout:', stdout);

    if (platform === 'win32' || isWsl()) {
      return stdout.includes('Antigravity.exe');
    } else {
      return stdout.trim().length > 0;
    }
  } catch (error) {
    console.error('Error:', error);
    return false;
  }
}

isProcessRunning().then((result) => {
  console.log('Result:', result);
});
