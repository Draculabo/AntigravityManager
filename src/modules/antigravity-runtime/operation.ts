import {
  resolveAntigravityAppTarget,
  type AntigravityAppTarget,
} from '@/shared/platform/antigravityAppTarget';
import { processError } from './processErrors';
import type { GuiTarget, LaunchContextOptions, ProcessOperation } from './types';
import { canonicalPath } from './launchContext';

interface TargetOperation {
  operation: ProcessOperation;
  startPromise?: Promise<void>;
}

const operations = new Map<string, TargetOperation>();

function getOperationKey(target: GuiTarget, options?: LaunchContextOptions | string): string {
  if (typeof options === 'string') {
    return options;
  }
  if (options?.userDataDir) {
    return `${target}:${canonicalPath(options.userDataDir)}`;
  }
  return target;
}

function getOperationState(key: string): TargetOperation {
  let state = operations.get(key);
  if (!state) {
    state = { operation: 'idle' };
    operations.set(key, state);
  }
  return state;
}

export function getProcessOperation(
  target?: AntigravityAppTarget | null,
  options?: LaunchContextOptions,
): ProcessOperation {
  const resolved = resolveAntigravityAppTarget(target);
  if (resolved === 'agy') {
    return 'idle';
  }
  const key = getOperationKey(resolved, options);
  return operations.get(key)?.operation ?? 'idle';
}

/** Own the target through preflight, close, credential writes and confirmed restart. */
export function reserveSwitch(
  target?: AntigravityAppTarget | null,
  options?: LaunchContextOptions | string,
): () => void {
  const resolved = resolveAntigravityAppTarget(target);
  if (resolved === 'agy') {
    return () => {};
  }
  const key = getOperationKey(resolved, options);
  const state = getOperationState(key);

  // If scoped switch, check if global target is busy
  if (key !== resolved) {
    const globalState = operations.get(resolved);
    if (globalState && globalState.operation !== 'idle') {
      throw processError('busy');
    }
  } else {
    // If global switch, check if any child profile is active
    const hasActiveChild = [...operations.entries()].some(
      ([k, s]) => k.startsWith(`${resolved}:`) && s.operation !== 'idle',
    );
    if (hasActiveChild) {
      throw processError('busy');
    }
  }

  if (state.operation !== 'idle') {
    throw processError('busy');
  }

  state.operation = 'switching';
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    state.operation = 'idle';
    if (key !== resolved) {
      operations.delete(key);
    }
  };
}

export function runProcessOperation<T = void>(
  target: GuiTarget,
  operation: 'starting' | 'stopping',
  action: () => Promise<T>,
  options?: LaunchContextOptions | string,
): Promise<T> {
  const key = getOperationKey(target, options);

  // If this is a scoped profile operation, verify global target is not busy
  if (key !== target) {
    const globalState = operations.get(target);
    if (globalState && globalState.operation !== 'idle') {
      return Promise.reject(processError('busy'));
    }
  } else {
    // If global operation, verify no scoped profile operation is in progress
    const hasActiveChild = [...operations.entries()].some(
      ([k, s]) => k.startsWith(`${target}:`) && s.operation !== 'idle',
    );
    if (hasActiveChild) {
      return Promise.reject(processError('busy'));
    }
  }

  const state = getOperationState(key);

  if (operation === 'starting' && state.startPromise) {
    return state.startPromise as Promise<T>;
  }
  if (state.operation !== 'idle') {
    return Promise.reject(processError('busy'));
  }

  state.operation = operation;
  const promise = Promise.resolve()
    .then(action)
    .finally(() => {
      state.operation = 'idle';
      state.startPromise = undefined;
      if (key !== target) {
        operations.delete(key);
      }
    });

  if (operation === 'starting') {
    state.startPromise = promise as Promise<void>;
  }
  return promise;
}
