const APPLY_PATCH_FAILURE_MARKERS = [
  'apply_patch verification failed',
  'Failed to find expected lines',
  'Failed to find context',
  'Expected update hunk',
] as const;

export class ApplyPatchFailureCompactor {
  private distinctCount = 0;
  private readonly seen = new Set<string>();

  public compact(output: string): string {
    if (!APPLY_PATCH_FAILURE_MARKERS.some((marker) => output.includes(marker))) {
      return output;
    }

    const fingerprint = output.split(/\r?\n/u).slice(0, 8).join('\n');
    if (this.seen.has(fingerprint)) {
      return '[Repeated apply_patch failure omitted: the same error was already provided earlier in this request.]';
    }

    this.seen.add(fingerprint);
    this.distinctCount += 1;
    if (this.distinctCount > 6) {
      return '[Additional apply_patch failure omitted to avoid a retry loop. Produce a fresh V4A patch from current file contents instead of repeating previous failed patches.]';
    }

    return output;
  }
}
