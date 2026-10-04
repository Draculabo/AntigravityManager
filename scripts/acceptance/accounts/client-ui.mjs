import { setTimeout as delay } from 'node:timers/promises';

/** Verify the actual official renderer; never retain its account text in the report. */
export async function verifyClientIdentity(
  browser,
  email,
  signedIn,
  { rendererRetried = false, completeSetup = false } = {},
) {
  const deadline = Date.now() + 30000;
  let page;
  while (!page && Date.now() < deadline) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => /^(file|vscode-file|https?):/.test(candidate.url()));
    if (!page) {
      await delay(500);
    }
  }
  if (!page) {
    const error = new Error('Official client renderer did not open');
    error.code = 'client-renderer-unavailable';
    error.clientPages = browser
      .contexts()
      .flatMap((context) => context.pages())
      .map((candidate) => new URL(candidate.url()).protocol);
    error.clientFailures = await Promise.all(
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .slice(0, 3)
        .map(async (candidate) => {
          let frames = [];
          let localNavigationError;
          const session = await candidate.context().newCDPSession(candidate);
          try {
            const { frameTree } = await session.send('Page.getFrameTree');
            if (frameTree.frame.unreachableUrl) {
              const failedUrl = new URL(frameTree.frame.unreachableUrl);
              if (failedUrl.protocol === 'https:' && failedUrl.hostname === '127.0.0.1') {
                const navigation = await Promise.race([
                  session.send('Page.navigate', { url: failedUrl.href }),
                  delay(5000).then(() => ({ errorText: 'diagnostic-navigation-timeout' })),
                ]);
                localNavigationError = navigation.errorText ?? null;
              }
            }
            frames = [frameTree.frame.url, frameTree.frame.unreachableUrl]
              .filter(Boolean)
              .map((value) => {
                const url = new URL(value);
                return {
                  protocol: url.protocol,
                  host: url.host,
                  resource: /^(file|vscode-file|https?):$/.test(url.protocol)
                    ? url.pathname.split('/').at(-1)
                    : undefined,
                };
              });
          } finally {
            await session.detach().catch(() => {});
          }
          return {
            protocol: new URL(candidate.url()).protocol,
            frames,
            localNavigationError,
            errorCodes: await candidate
              .evaluate(() => [...new Set(document.body?.innerText.match(/ERR_[A-Z_]+/g) ?? [])])
              .catch(() => []),
          };
        }),
    );
    if (
      !rendererRetried &&
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .some((candidate) => candidate.url().startsWith('https:'))
    ) {
      const recovered = await verifyClientIdentity(browser, email, signedIn, {
        rendererRetried: true,
        completeSetup,
      });
      return { ...recovered, rendererRecoveredFromInitialFailure: true };
    }
    throw error;
  }
  await page.waitForFunction(() => document.body?.innerText.trim().length > 0, undefined, {
    timeout: 30000,
  });
  if (completeSetup) {
    for (let step = 0; step < 8; step++) {
      const next = page.getByRole('button', { name: 'Next', exact: true });
      if (!(await next.isVisible())) {
        break;
      }
      await next.click({ timeout: 3000 });
      await delay(750);
    }
    const finish = page.getByRole('button', { name: 'Finish', exact: true });
    if (await finish.isVisible()) {
      const consent = page.getByRole('checkbox');
      if ((await consent.count()) === 1) {
        await consent.uncheck();
      }
      await finish.click({ timeout: 3000 });
      await delay(3000);
    }
  }
  const identity = page.getByText(email, { exact: false }).filter({ visible: true }).first();
  let visible = await identity.isVisible().catch(() => false);
  if (!visible) {
    const accountButton = page
      .getByRole('button', { name: /^(Accounts?|Manage Account|Quick Settings Panel|Profile)$/i })
      .first();
    if (await accountButton.isVisible().catch(() => false)) {
      await accountButton.click();
    } else {
      const settings = page.getByRole('button', { name: 'Settings', exact: true });
      if (await settings.isVisible().catch(() => false)) {
        await settings.click();
      }
    }
  }
  const authenticationDeadline = Date.now() + 60000;
  let authenticated = false;
  let screen;
  while (Date.now() < authenticationDeadline) {
    visible = await identity.isVisible().catch(() => false);
    authenticated = await signedIn();
    screen = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        onboarding: /Welcome|Get started|Set up|Next/i.test(text),
        signInRequired: /Sign in|Log in/i.test(text),
        authenticating: /Authenticating/i.test(text),
        textLength: text.length,
      };
    });
    if (authenticated || (visible && !screen.authenticating && !screen.signInRequired)) {
      break;
    }
    await delay(500);
  }
  const result = {
    clientWindow: true,
    clientIdentityVisible: visible,
    clientSignedIn: authenticated,
    clientIdentityConfirmed:
      authenticated || (visible && !screen.authenticating && !screen.signInRequired),
    clientVerification: visible ? 'identity-visible' : 'credentials-and-window-only',
  };
  if (!visible) {
    result.clientScreen = screen;
  }
  return result;
}
