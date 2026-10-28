import fs from 'node:fs/promises';
import path from 'node:path';
import { isEqual } from 'lodash-es';
import { getAgentDir } from '@/shared/platform/paths';
import { logger } from '@/shared/logging/logger';
import { getAntigravityVersion } from '../utils/antigravityVersion';
import { canonicalPath, assertContextProcesses } from '../launchContext';
import { observeProcesses } from '../processObserver';
import type { LaunchContext } from '../types';
import {
  USERNAME,
  TERMS_TYPE,
  acceptedTerms,
  digest,
  historyFile,
  mergeAcceptance,
  readDocument,
  readHistory,
  writeDocument,
  type AcceptedTerms,
  type TermsDocument,
  type TermsHistory,
} from './classicTermsStore';

export interface ClassicTermsSwitch {
  captureForHotSwitch(): Promise<void>;
  confirmHotSwitch(): Promise<boolean>;
  apply(): Promise<void>;
  rollback(): Promise<void>;
}

async function assertStopped(context: LaunchContext): Promise<void> {
  const processes = await observeProcesses(context.target, undefined, context.executablePath);
  assertContextProcesses(context, processes);
  if (processes.length) {
    throw new Error('Classic terms require a stopped client');
  }
}

/** Capture genuine official records before shutdown; apply only after confirmed exit and credential write. */
export async function prepareClassicTermsSwitch(
  context: LaunchContext,
  email: string,
): Promise<ClassicTermsSwitch | null> {
  if (process.platform !== 'win32' || context.target !== 'classic') {
    return null;
  }
  const profile = canonicalPath(context.pathOptions.userDataDir || context.defaultUserDataDir);
  const file = path.join(profile, 'app_storage.json');
  const version = await getAntigravityVersion('classic', context.executablePath).catch(() => null);
  if (!version) {
    logger.warn('Classic terms retention skipped because the client version is unavailable');
    return null;
  }
  const executable = await fs.stat(context.executablePath);
  const revision = digest(
    [
      canonicalPath(context.executablePath),
      version.shortVersion,
      version.bundleVersion,
      executable.size,
      executable.mtimeMs,
    ].join('|'),
  );
  const cache = historyFile(getAgentDir(), profile);
  const stored = await readHistory(cache);
  const canLearn =
    stored.state === 'missing' ||
    (stored.state === 'valid' && stored.history.revision === revision);
  const history: TermsHistory =
    stored.state === 'valid' && stored.history.revision === revision
      ? stored.history
      : { version: 1, revision, entries: [] };
  let captured: AcceptedTerms | null = null;
  try {
    captured = acceptedTerms(await readDocument(file));
  } catch {
    // The official writer is asynchronous; the stopped-client read remains authoritative.
    logger.warn('Classic terms snapshot is pending a stopped-client read');
  }
  let previous: TermsDocument | null = null;
  let applied: TermsDocument | null = null;
  function remember(acceptance: AcceptedTerms | null) {
    if (!acceptance) {
      return;
    }
    const account = digest(acceptance.email);
    history.entries = history.entries.filter((entry) => entry.account !== account);
    history.entries.push({ account, termsType: acceptance.termsType });
    history.entries = history.entries.slice(-256);
  }
  return {
    async confirmHotSwitch() {
      const deadline = Date.now() + 5000;
      do {
        const official = acceptedTerms(await readDocument(file));
        if (canLearn && official && digest(official.email) === digest(email)) {
          return true;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))),
        );
      } while (Date.now() < deadline);
      return false;
    },
    async captureForHotSwitch() {
      const currentExecutable = await fs.stat(context.executablePath);
      if (
        currentExecutable.size !== executable.size ||
        currentExecutable.mtimeMs !== executable.mtimeMs
      ) {
        throw new Error('Classic installation changed before terms capture');
      }
      if (canLearn) {
        remember(captured);
        await writeDocument(cache, history);
      }
    },
    async apply() {
      const currentExecutable = await fs.stat(context.executablePath);
      if (
        currentExecutable.size !== executable.size ||
        currentExecutable.mtimeMs !== executable.mtimeMs
      ) {
        throw new Error('Classic installation changed before terms restoration');
      }
      await assertStopped(context);
      previous = await readDocument(file);
      if (canLearn) {
        remember(captured);
        remember(acceptedTerms(previous));
      }
      const target = history.entries.find((entry) => entry.account === digest(email));
      const next = mergeAcceptance(
        previous || {},
        target ? { email, termsType: target.termsType } : null,
      );
      // Persist history before replacing the single official slot. Failure never loses the last observed record.
      if (canLearn) {
        await writeDocument(cache, history);
      }
      if (!isEqual(previous || {}, next)) {
        await assertStopped(context);
        if (!isEqual(await readDocument(file), previous)) {
          throw new Error('Classic terms storage changed before write');
        }
        await writeDocument(file, next);
        applied = next;
        const readback = await readDocument(file);
        if (!isEqual(readback, next)) {
          throw new Error('Classic terms write could not be confirmed');
        }
      }
      logger.info('Classic terms state prepared', {
        outcome: !canLearn ? 'invalidated' : target ? 'restored' : 'confirmation-required',
      });
      if (!canLearn) {
        // Keep the old revision authoritative until stale official fields have been removed.
        await writeDocument(cache, history);
      }
    },
    async rollback() {
      if (!applied) {
        return;
      }
      await assertStopped(context);
      const current = await readDocument(file);
      // Never overwrite a later official acceptance or unrelated settings during recovery.
      if (
        !current ||
        !isEqual(current[USERNAME], applied[USERNAME]) ||
        !isEqual(current[TERMS_TYPE], applied[TERMS_TYPE])
      ) {
        throw new Error('Classic terms changed before rollback');
      }
      const restored = { ...current };
      for (const key of [USERNAME, TERMS_TYPE]) {
        delete restored[key];
        if (previous && Object.hasOwn(previous, key)) {
          restored[key] = previous[key];
        }
      }
      await writeDocument(file, restored);
      applied = null;
    },
  };
}
