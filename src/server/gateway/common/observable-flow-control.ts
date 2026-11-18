import type { Observable } from 'rxjs';

export interface ObservableFlowControl {
  pause(): void;
  resume(): void;
}

const flowControls = new WeakMap<object, ObservableFlowControl>();

export function registerObservableFlowControl<T>(
  observable: Observable<T>,
  control: ObservableFlowControl,
): Observable<T> {
  flowControls.set(observable, control);
  return observable;
}

export function inheritObservableFlowControl<T>(
  source: Observable<unknown>,
  target: Observable<T>,
): Observable<T> {
  const control = flowControls.get(source);
  if (control) {
    flowControls.set(target, control);
  }
  return target;
}

export function getObservableFlowControl(
  observable: Observable<unknown>,
): ObservableFlowControl | undefined {
  return flowControls.get(observable);
}

export function createReadableFlowControl(stream: NodeJS.ReadableStream): ObservableFlowControl {
  return {
    pause: () => stream.pause(),
    resume: () => stream.resume(),
  };
}
