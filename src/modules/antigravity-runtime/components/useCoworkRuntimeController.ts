import { useEffect, useRef, useState } from 'react';
import { ipc } from '@/ipc/manager';
import {
  CoworkFailureCodeSchema,
  type CoworkFailureCode,
  type CoworkLifecycleResult,
  type CoworkPreview,
  type CoworkReceipt,
  type CoworkTarget,
} from '../cowork/contracts';

export type CoworkConfirmation =
  | { kind: 'write'; preview: CoworkPreview }
  | { kind: 'lifecycle'; target: CoworkTarget; action: 'stop' | 'start' };

export type CoworkOperationResult =
  | { kind: 'receipt'; target: CoworkTarget; receipt: CoworkReceipt }
  | { kind: 'unknown'; target: CoworkTarget; action: 'apply' | 'restore' | 'stop' | 'start' }
  | { kind: 'lifecycle'; target: CoworkTarget; result: CoworkLifecycleResult };

type Pending = 'scan' | 'inspect' | 'preview' | 'lifecycle' | 'mutation';

export function useCoworkRuntimeController() {
  const [candidates, setCandidates] = useState<CoworkTarget[]>([]);
  const [selected, setSelected] = useState<CoworkTarget | null>(null);
  const [scanned, setScanned] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [preview, setPreview] = useState<CoworkPreview | null>(null);
  const [lifecycle, setLifecycle] = useState<CoworkLifecycleResult | null>(null);
  const [confirmation, setConfirmation] = useState<CoworkConfirmation | null>(null);
  const [result, setResult] = useState<CoworkOperationResult | null>(null);
  const [error, setError] = useState<CoworkFailureCode | 'read-error' | null>(null);
  const gate = useRef<Pending | null>(null);
  const request = useRef(0);
  const currentSelection = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, []);

  const begin = (action: Pending) => {
    if (gate.current) {
      return false;
    }
    gate.current = action;
    setPending(action);
    setError(null);
    return true;
  };

  const finish = () => {
    gate.current = null;
    if (mounted.current) {
      setPending(null);
    }
  };

  const select = (target: CoworkTarget) => {
    if (gate.current === 'mutation') {
      return;
    }
    request.current += 1;
    currentSelection.current = target.selectionId;
    setSelected(target);
    setPreview(null);
    setLifecycle(null);
    setConfirmation(null);
    setError(null);
  };

  const scan = async (customPath: string) => {
    if (!begin('scan')) {
      return;
    }
    const id = ++request.current;
    currentSelection.current = null;
    setCandidates([]);
    setSelected(null);
    setPreview(null);
    setLifecycle(null);
    setConfirmation(null);
    setScanned(false);
    try {
      const path = customPath.trim();
      const targets = await ipc.client.coworkRuntime.discover(path ? { customPath: path } : {});
      if (mounted.current && request.current === id) {
        setCandidates(targets);
        setSelected(targets[0] ?? null);
        currentSelection.current = targets[0]?.selectionId ?? null;
        setScanned(true);
      }
    } catch (cause) {
      if (mounted.current && request.current === id) {
        const code = CoworkFailureCodeSchema.safeParse(cause instanceof Error ? cause.message : null);
        setError(code.success ? code.data : 'read-error');
      }
    } finally {
      finish();
    }
  };

  const read = async (action: 'inspect' | 'apply' | 'restore' | 'lifecycle') => {
    const target = selected;
    if (!target || currentSelection.current !== target.selectionId ||
      (action === 'apply' && target.recovery === 'interrupted')) {
      return;
    }
    if (!begin(action === 'apply' || action === 'restore' ? 'preview' : action)) {
      return;
    }
    const id = ++request.current;
    const isCurrent = () => mounted.current && request.current === id;
    setPreview(null);
    setLifecycle(null);
    setConfirmation(null);
    try {
      let inspected = target;
      if (action === 'inspect') {
        inspected = await ipc.client.coworkRuntime.inspect({ selectionId: target.selectionId });
      } else if (action !== 'lifecycle') {
        const prepared = await ipc.client.coworkRuntime.preview({
          selectionId: target.selectionId,
          action,
        });
        inspected = prepared.target;
        if (isCurrent()) {
          setPreview(prepared);
        }
      }
      if (isCurrent() && action !== 'lifecycle') {
        setSelected(inspected);
        setCandidates((current) => current.map((candidate) =>
          candidate.selectionId === inspected.selectionId ? inspected : candidate,
        ));
      }
      if (isCurrent() && inspected.eligibility.kind === 'eligible') {
        const process = await ipc.client.coworkRuntime.lifecycle({
          selectionId: inspected.selectionId,
          action: 'inspect',
        });
        if (isCurrent()) {
          setLifecycle(process);
        }
      }
    } catch (cause) {
      if (isCurrent()) {
        const code = CoworkFailureCodeSchema.safeParse(cause instanceof Error ? cause.message : null);
        setError(code.success ? code.data : 'read-error');
      }
    } finally {
      finish();
    }
  };

  const canWrite = preview !== null && preview.state === 'ready' && preview.previewId !== null &&
    preview.selectionId === selected?.selectionId && preview.target.eligibility.kind === 'eligible' &&
    (preview.action === 'restore' || preview.target.recovery !== 'interrupted') &&
    preview.signature === 'not-required' && preview.lifecycle === 'selected-instance' &&
    lifecycle?.selectionId === preview.selectionId && lifecycle.code === null &&
    (lifecycle.state === 'running' || lifecycle.state === 'stopped');

  const reviewWrite = () => {
    if (!gate.current && canWrite && preview) {
      setConfirmation({ kind: 'write', preview });
    }
  };

  const reviewLifecycle = (action: 'stop' | 'start') => {
    if (!gate.current && selected?.eligibility.kind === 'eligible' &&
      (action !== 'start' || selected.recovery !== 'interrupted') &&
      lifecycle?.selectionId === selected.selectionId && lifecycle.code === null &&
      lifecycle.state === (action === 'stop' ? 'running' : 'stopped')) {
      setConfirmation({ kind: 'lifecycle', target: selected, action });
    }
  };

  const dismiss = () => {
    if (gate.current !== 'mutation') {
      setConfirmation(null);
    }
  };

  const confirm = async (restart: boolean) => {
    const plan = confirmation;
    if (!plan) {
      return;
    }
    const target = plan.kind === 'write' ? plan.preview.target : plan.target;
    if (target.selectionId !== currentSelection.current || target.eligibility.kind !== 'eligible') {
      return;
    }
    if (plan.kind === 'write' && (!canWrite || plan.preview.previewId !== preview?.previewId)) {
      return;
    }
    if (!begin('mutation')) {
      return;
    }
    request.current += 1;
    setPreview(null);
    setLifecycle(null);
    setResult(null);
    try {
      if (plan.kind === 'write' && plan.preview.previewId) {
        const input = { selectionId: target.selectionId, previewId: plan.preview.previewId, restart };
        const receipt = plan.preview.action === 'apply'
          ? await ipc.client.coworkRuntime.apply(input)
          : await ipc.client.coworkRuntime.restore(input);
        // A dispatched mutation owns its result even when read requests are invalidated.
        if (mounted.current) {
          setResult({ kind: 'receipt', target, receipt });
        }
      } else if (plan.kind === 'lifecycle') {
        const process = await ipc.client.coworkRuntime.lifecycle({
          selectionId: target.selectionId,
          action: plan.action,
        });
        if (mounted.current) {
          setResult({ kind: 'lifecycle', target, result: process });
          setLifecycle(process);
        }
      }
    } catch {
      if (mounted.current) {
        setResult({
          kind: 'unknown', target,
          action: plan.kind === 'write' ? plan.preview.action : plan.action,
        });
      }
    } finally {
      if (mounted.current) {
        if (plan.kind === 'write') {
          // Discovery binds the old hash even when a write reply is lost.
          currentSelection.current = null;
          setSelected(null);
          setCandidates((current) => current.filter(
            (candidate) => candidate.selectionId !== target.selectionId,
          ));
          setScanned(false);
        }
        setConfirmation(null);
      }
      finish();
    }
  };

  return {
    candidates, selected, scanned, pending, preview, lifecycle, confirmation, result, error,
    canWrite, select, scan, read, reviewWrite, reviewLifecycle, dismiss, confirm,
  };
}
