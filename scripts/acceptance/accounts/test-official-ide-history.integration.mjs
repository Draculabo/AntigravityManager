import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import spawn from 'cross-spawn';
import { chromium } from 'playwright';
import { createCommand } from './process-actions.mjs';
import { createCredentialReadback } from './credential-readback.mjs';
import { verifyClientIdentity } from './client-ui.mjs';
import { readOfficialSignedIn } from './official-auth-state.mjs';

const switchAccounts = process.argv.includes('--switch-accounts');
const duringGeneration = process.argv.includes('--during-generation');
const extendedClose = process.argv.includes('--extended-close');
assert(!extendedClose || duringGeneration, 'Extended close is a separate streaming diagnostic');
assert(!(switchAccounts && duringGeneration), 'Run streaming and account-switch cases separately');

const home = path.resolve('out/account-switch-acceptance/windows-cli-home');
assert.equal(process.platform, 'win32');
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData/Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData/Local'),
});
const config = JSON.parse(
  await fs.readFile(path.join(home, '.antigravity-agent/gui_config.json'), 'utf8'),
);
assert(config.antigravity_ide_args.includes(`--user-data-dir=${path.join(home, 'client-ide')}`));
const library = createRequire(import.meta.url)(
  '../../../out/account-switch-acceptance/helpers/runtime.cjs',
);
const marker = 'AGM_HISTORY_ACCEPTANCE_' + Date.now();
const report = {
  version: 1,
  platform: process.platform,
  normalClose: false,
  restarted: false,
  conversationRestored: false,
};
const output = `out/account-switch-acceptance/windows-ide-history${switchAccounts ? '-switch' : duringGeneration ? '-streaming' : ''}-report.json`;
const runtime = path.resolve('dist/.runtime/win32-x64/standalone');
const node = path.join(runtime, 'node/node.exe');
const cli = path.join(runtime, 'cli/main.cjs');
const command = createCommand(process.env);
let originalCredential;
let replyExcerpts;
let conversationFile;
let credentialCaptured = false;
let serviceStarted = false;
async function switchAccount(id, alias) {
  const since = Date.now();
  await command(node, [cli, 'account', 'switch', id, '--target', 'ide']);
  const nativeRequire = createRequire(path.join(runtime, 'package.json'));
  const readback = createCredentialReadback({
    library,
    Database: nativeRequire('better-sqlite3'),
    config,
    home,
  });
  const expected = await readback.expectedAccount(id);
  const token = await readback.readTarget('ide');
  assert.equal(token.refreshToken, expected.token.refresh_token);
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token.accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).email.toLowerCase(), expected.email.toLowerCase());
  browser = await connect();
  const identity = await verifyClientIdentity(browser, expected.email, () =>
    readOfficialSignedIn(home, 'ide', since),
  );
  assert(identity.clientIdentityConfirmed);
  const clientPage = await renderer(browser);
  await clientPage.keyboard.press('Escape');
  report.accountChecks ??= [];
  report.accountChecks.push({
    account: alias,
    tokenReadback: true,
    googleIdentity: true,
    officialIdentity: true,
  });
}
let browser;
async function checkpoint(stage) {
  report.stage = stage;
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ stage }));
}
async function connect() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return await chromium.connectOverCDP('http://127.0.0.1:9342', { timeout: 1000 });
    } catch {
      await delay(500);
    }
  }
  throw new Error('isolated-renderer-unavailable');
}
async function renderer(browser) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('vscode-file:'));
    if (page) {
      page.setDefaultTimeout(15000);
      return page;
    }
    await delay(500);
  }
  throw new Error('isolated-renderer-unavailable');
}
try {
  let ids;
  if (switchAccounts) {
    originalCredential = await library.readWindowsCredential('gemini:antigravity');
    credentialCaptured = true;
    ids = JSON.parse(await fs.readFile('out/account-switch-acceptance/account-pair.json', 'utf8'));
    assert.equal(ids.length, 2);
    await checkpoint('start-isolated-owner');
    await command(node, [cli, 'service', 'start']);
    serviceStarted = true;
    await checkpoint('switch-to-A');
    await switchAccount(ids[0], 'A');
  }
  await checkpoint('connect');
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9342', { timeout: 1000 });
  } catch {
    const child = spawn(config.antigravity_ide_executable, config.antigravity_ide_args, {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    browser = await connect();
  }
  const page = await renderer(browser);
  const setupCancel = page.getByRole('button', { name: 'Cancel', exact: true });
  if (await setupCancel.isVisible()) {
    await setupCancel.click();
  }
  const openHistory = async (page) => {
    const search = page.getByPlaceholder('Search all convos...');
    if (!(await search.isVisible())) {
      const toggle = page.locator('[data-past-conversations-toggle=true]');
      await toggle.waitFor({ state: 'visible', timeout: 30000 });
      try {
        await toggle.click({ timeout: 3000 });
      } catch (error) {
        const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
        if (!(await cancel.isVisible())) {
          throw error;
        }
        await cancel.click();
        await toggle.click({ timeout: 15000 });
      }
    }
    await search.waitFor({ state: 'visible' });
    if (await search.inputValue()) {
      await search.fill('');
      await delay(1000);
    }
    // Official IDE groups show only four conversations until explicitly expanded.
    const showMore = page.locator('#fastpick-listbox [id^="fastpick-show-more-"]');
    for (let group = 0; group < 10 && (await showMore.count()); group++) {
      await showMore.first().click();
    }
    assert.equal(await showMore.count(), 0, 'All history groups must be expanded');
    return search;
  };
  await checkpoint('capture-history-baseline');
  await openHistory(page);
  const baselineIds = new Set(
    await page
      .locator('#fastpick-listbox [role=option][id^="fastpick-item-"]')
      .evaluateAll((rows) => rows.map((row) => row.id)),
  );
  const baselineSearch = page.getByPlaceholder('Search all convos...');
  await baselineSearch.press('Escape');
  await baselineSearch.waitFor({ state: 'hidden', timeout: 5000 });
  await checkpoint('new-conversation');
  await page.locator('[data-tooltip-id=new-conversation-tooltip]').click();
  await checkpoint('submit-chat');
  const editor = page.locator('[contenteditable=true][aria-label="Message input"]');
  await checkpoint('wait-editor');
  await editor.waitFor({ state: 'visible', timeout: 30000 });
  await editor.pressSequentially(
    duringGeneration
      ? `Start your response with ${marker} on its own line. Then write 400 numbered sentences about organizing a desk. Do not use tools or modify files.`
      : `Reply with exactly ${marker}. Do not use tools or modify files.`,
    { delay: 5 },
  );
  await checkpoint('send-message');
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  report.sendButtonEnabled = await send.isEnabled();
  await checkpoint('send-message');
  await editor.press('Enter');
  await checkpoint('wait-provider');
  if (duringGeneration) {
    await page
      .getByText(marker, { exact: true })
      .first()
      .waitFor({ state: 'visible', timeout: 120000 });
    await page.waitForFunction(
      (marker) => {
        const panel = document.querySelector('[aria-label="Agent Conversation"]');
        const stop = [...document.querySelectorAll('button,[role=button]')].some(
          (button) =>
            button.getClientRects().length > 0 &&
            button.getAttribute('data-tooltip-id') === 'input-send-button-cancel-tooltip',
        );
        return stop && (panel?.innerText.split(marker).length ?? 0) >= 3;
      },
      marker,
      { timeout: 120000 },
    );
    report.generationActiveObserved = true;
    await page.waitForFunction(
      (marker) => {
        const paragraph = [...document.querySelectorAll('p')].find(
          (element) => element.textContent.trim() === marker,
        );
        const items = [...(paragraph?.parentElement.querySelectorAll('li') ?? [])].slice(0, 2);
        return items.length === 2 && items.every((item) => item.innerText.trim().length >= 20);
      },
      marker,
      { timeout: 30000 },
    );
  } else {
    await page
      .getByText(marker, { exact: true })
      .first()
      .waitFor({ state: 'visible', timeout: 120000 });
    report.providerReply = true;
  }
  await checkpoint('verify-history-before-close');
  await openHistory(page);
  const historyDeadline = Date.now() + 15000;
  let conversationId;
  while (!conversationId && Date.now() < historyDeadline) {
    const added = (
      await page
        .locator('#fastpick-listbox [role=option][id^="fastpick-item-"]')
        .evaluateAll((rows) => rows.map((row) => row.id))
    ).filter((id) => !baselineIds.has(id));
    assert(added.length <= 1, 'The isolated run must create exactly one identifiable conversation');
    conversationId = added[0];
    if (!conversationId) {
      await delay(500);
    }
  }
  assert(conversationId, 'Test conversation must be listed before shutdown');
  if (duringGeneration) {
    const search = page.getByPlaceholder('Search all convos...');
    await search.press('Escape');
    await search.waitFor({ state: 'hidden', timeout: 5000 });
    report.generationActiveAtClose = await page.evaluate(() =>
      [...document.querySelectorAll('button,[role=button]')].some(
        (button) =>
          button.getClientRects().length > 0 &&
          button.getAttribute('data-tooltip-id') === 'input-send-button-cancel-tooltip',
      ),
    );
    assert(
      report.generationActiveAtClose,
      'Generation must still be active immediately before close',
    );
    replyExcerpts = await page
      .getByText(marker, { exact: true })
      .first()
      .evaluate((element) => {
        let container = element.parentElement;
        while (
          container &&
          container.querySelectorAll('li').length < 2 &&
          container.getAttribute('aria-label') !== 'Agent Conversation'
        ) {
          container = container.parentElement;
        }
        return [...(container?.querySelectorAll('li') ?? [])]
          .slice(0, 2)
          .map((item) => item.innerText.trim().slice(0, 100));
      });
    report.capturedReplyExcerptLengths = replyExcerpts.map((text) => text.length);
    assert(
      replyExcerpts.length === 2 && replyExcerpts.every((text) => text.length >= 20),
      'Capture actual generated response text',
    );
    const nativeRequire = createRequire(path.join(runtime, 'package.json'));
    const Database = nativeRequire('better-sqlite3');
    conversationFile = path.join(
      home,
      '.gemini/antigravity-ide/conversations',
      `${conversationId.replace(/^fastpick-item-/, '')}.db`,
    );
    const db = new Database(conversationFile, { readonly: true });
    try {
      const rows = db.prepare('SELECT step_payload FROM steps').all();
      report.replyPersistedBeforeClose = replyExcerpts.every((text) =>
        rows.some(
          (row) =>
            Buffer.isBuffer(row.step_payload) && row.step_payload.includes(Buffer.from(text)),
        ),
      );
    } finally {
      db.close();
    }
  } else {
    await page.locator(`[id="${conversationId}"]`).click();
    await page
      .getByText(marker, { exact: true })
      .first()
      .waitFor({ state: 'visible', timeout: 30000 });
    report.historyReopenBeforeClose = true;
  }
  await checkpoint('normal-close');
  const context = await library.prepareLaunchContext('ide');
  assert.equal(context.pathOptions.userDataDir, path.join(home, 'client-ide'));
  report.closeBudgetMs = extendedClose ? 60000 : 15000;
  await library.stopFromContext(context, report.closeBudgetMs);
  report.normalClose = true;
  await Promise.race([browser.close().catch(() => {}), delay(3000)]);
  await library.startFromContext(context);
  report.restarted = true;
  if (duringGeneration) {
    const Database = createRequire(path.join(runtime, 'package.json'))('better-sqlite3');
    const db = new Database(conversationFile, { readonly: true });
    try {
      const rows = db.prepare('SELECT step_payload FROM steps').all();
      report.replyPersistedAfterRestart = replyExcerpts.every((text) =>
        rows.some(
          (row) =>
            Buffer.isBuffer(row.step_payload) && row.step_payload.includes(Buffer.from(text)),
        ),
      );
    } finally {
      db.close();
    }
    assert(report.replyPersistedAfterRestart, 'Captured generated text must survive restart');
  }
  await checkpoint('restore-history');
  browser = await connect();
  const restored = await renderer(browser);
  const migrationCancel = restored.getByRole('button', { name: 'Cancel', exact: true });
  if (await migrationCancel.isVisible()) {
    await migrationCancel.click();
  }
  await openHistory(restored);
  await checkpoint('locate-restored-history-entry');
  const savedConversation = restored.locator(`[id="${conversationId}"]`);
  await savedConversation.waitFor({ state: 'visible', timeout: 15000 });
  await savedConversation.click();
  report.historyEntryRestored = true;
  await checkpoint('verify-restored-reply');
  await restored
    .getByText(marker, { exact: !duringGeneration })
    .first()
    .waitFor({ state: 'visible', timeout: 30000 });
  if (duringGeneration) {
    await restored.waitForFunction(
      (excerpts) =>
        excerpts.every((text) =>
          document.querySelector('[aria-label="Agent Conversation"]')?.textContent.includes(text),
        ),
      replyExcerpts,
      { timeout: 30000 },
    );
    report.partialReplyRestored = true;
    report.capturedReplyExcerptsRestored = true;
  }
  report.conversationRestored = true;
  if (switchAccounts) {
    for (const [index, alias] of [
      [1, 'B'],
      [0, 'A'],
    ]) {
      await checkpoint(`switch-to-${alias}`);
      await Promise.race([browser.close(), delay(3000)]);
      await switchAccount(ids[index], alias);
      const switchedPage = await renderer(browser);
      await openHistory(switchedPage);
      await switchedPage.locator(`[id="${conversationId}"]`).click();
      await switchedPage
        .getByText(marker, { exact: true })
        .first()
        .waitFor({ state: 'visible', timeout: 30000 });
      report.accountChecks.at(-1).conversationRestored = true;
    }
    report.crossAccountHistory = true;
  }
  report.status = 'passed';
} catch (error) {
  const failurePage = browser
    ?.contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().startsWith('vscode-file:'));
  await failurePage
    ?.screenshot({ path: 'out/account-switch-acceptance/ide-history-failure.png', timeout: 3000 })
    .catch(() => {});
  report.failedStage = report.stage;
  report.status = 'failed';
  report.errorKind = error.name;
  report.failureAction = error.message?.includes('intercepts pointer events')
    ? 'overlay-intercepted'
    : error.message?.includes('waiting for locator')
      ? 'locator-unavailable'
      : 'other';
  report.failureCategory =
    error.messageKey ??
    (error.name === 'TimeoutError' ? 'ui-or-provider-timeout' : 'acceptance-failed');
  process.exitCode = 1;
} finally {
  await checkpoint(report.status ?? 'interrupted');
  if (browser) {
    await Promise.race([
      browser
        .newBrowserCDPSession()
        .then((s) => s.send('Browser.close'))
        .catch(() => {}),
      delay(3000),
    ]);
    await Promise.race([browser.close().catch(() => {}), delay(3000)]);
  }
  if (serviceStarted) {
    await command(node, [cli, 'service', 'stop']).then(
      () => {
        report.ownerStopped = true;
      },
      () => {
        report.ownerStopped = false;
        report.status = 'failed';
        process.exitCode = 1;
      },
    );
  }
  if (credentialCaptured) {
    if (originalCredential !== null) {
      await library.writeWindowsCredential('gemini:antigravity', 'antigravity', originalCredential);
    } else {
      createRequire(path.join(runtime, 'package.json'))('@napi-rs/keyring')
        .Entry.withTarget('gemini:antigravity', 'gemini', 'antigravity')
        .deleteCredential();
    }
    report.originalCredentialRestored =
      (await library.readWindowsCredential('gemini:antigravity')) === originalCredential;
    if (!report.originalCredentialRestored) {
      report.status = 'failed';
      process.exitCode = 1;
    }
  }
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  process.exit(process.exitCode ?? 0);
}
