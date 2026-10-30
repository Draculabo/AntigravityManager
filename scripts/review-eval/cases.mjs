// Evaluator-only answers. Preparation exports source snapshots without these labels or rubrics.
export const CASES = [
  {
    id: 'appimage-pnpm-patch',
    before: '3e350a62dff243fc76f0f3bbeef9bcfc5b4eac83',
    fixed: '420ea77192d2f39bdc9c6aa2b9370bfc25e78e10',
    paths: ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'forge.config.ts', 'patches/'],
    task: 'Audit AppImage maker customization under the declared pnpm toolchain, including installations with lifecycle scripts disabled. Determine whether the shipped patch participates in dependency installation. Cite concrete configuration and behavior; keep unrelated packaging concerns separate.',
    rubric:
      'The maker patch exists but is absent from pnpm patchedDependencies and its lockfile patch identity. Installing with pnpm therefore omits the intended architecture, spaced-path and FUSE-free execution changes. The fixed snapshot registers the renamed patch and lockfile identity. Merely requesting a dependency upgrade or assuming all patch files are automatically applied is not detection.',
    evidence:
      'Fix commit 420ea77192d2f39bdc9c6aa2b9370bfc25e78e10; docs/development/build-and-package.md and the patch registration diff. The historical probe checks registration and referenced patch contents, not a Linux build.',
    preserve:
      'Keep the pnpm patch mechanism, lockfile identity and lifecycle-disabled installation support. A fixed control is clean only for this target defect, not certified bug-free.',
  },
  {
    id: 'quota-family-tiers',
    before: '86a36001e65a1b1390bdbbdb6c9789f2949679bc',
    fixed: '3e350a62dff243fc76f0f3bbeef9bcfc5b4eac83',
    paths: [
      'src/modules/cloud-account/utils/quota-model-families.ts',
      'src/modules/cloud-account/utils/quota-display.ts',
      'src/modules/cloud-account/components/CloudAccountCard.tsx',
      'src/modules/cloud-account/types.ts',
    ],
    task: 'Audit quota summaries and presentation when the provider advertises Gemini 4 Argon and Gemini 3.8 Flash low/medium/high model IDs. Each family shares an allowance. Summaries must remain conservative and unknown models must remain independent. Trace family handling and relevant UI consumers; report supported defects and evidence limits.',
    rubric:
      'Argon and 3.8 Flash IDs fall through as independent families, so tiers render separately and family summaries count them separately. Detect missing recognition/display names and their summary or presentation consequence. The fixed snapshot groups tiers, takes the minimum percentage and supplies product display names. Claiming that each shared tier must remain a separate presentation row is harmful.',
    evidence:
      'Fix commit 3e350a62dff243fc76f0f3bbeef9bcfc5b4eac83 (#367); src/tests/unit/quota-model-families.test.ts adds complete aggregation/presentation assertions. The historical probe executes both historical utility versions with synthetic quotas.',
    preserve:
      'Preserve minimum-percentage aggregation, unknown-model independence and distinct handling of the existing exact-presentation families.',
  },
  {
    id: 'same-profile-process-descendant',
    before: 'e1faed6c79f979d095ae84d39a87069f94c012d4',
    fixed: '9a3ffcb33556947772e9badf4b01c6d08c435181',
    paths: [
      'src/modules/antigravity-runtime/processObserver.ts',
      'src/modules/antigravity-runtime/runtimePaths.ts',
      'src/modules/antigravity-runtime/classicHotSwitch.ts',
      'src/shared/platform/antigravityProcessIdentity.ts',
    ],
    task: 'Audit client-main observation during account switching. Native snapshots can include a main and a descendant using the same executable and explicit profile, followed by a snapshot after that descendant exits. Trace the resulting main identity set and its ownership consumers. Distinct or unknown profiles and independent instances must remain visible. Report supported defects and the limits of synthetic process evidence.',
    rubric:
      'The observer retains every explicit-profile descendant before examining ancestry. A same-executable, same-profile helper is captured as a main; its retirement then changes the captured main set and can fail hot replacement and restart ownership while the real main survives. The repair excludes only descendants with provable ancestry and the same explicit canonical profile as their nearest client ancestor. Removing all explicit-profile descendants or weakening restart identity checks is harmful.',
    evidence:
      'Fix commit 9a3ffcb33556947772e9badf4b01c6d08c435181; runtime-observer-profile.test.ts and the 2026-10-28 Classic recovery Agent Note document the reproduced shape, not a confirmed cause for every production report. The historical probe executes the observer with synthetic snapshots and controlled platform/path dependencies.',
    preserve:
      'Keep different or unknown profiles and independent roots visible. Preserve executable and creation-time ancestry checks and strict captured-main ownership.',
  },
  {
    id: 'sqlite-parent-queue-yield',
    before: '0ce7766c10d21547fe8d50dc31b6ef8cf8148b23',
    fixed: '4d0763fef30d5441f3b3b43009712ec9033daacd',
    paths: [
      'src/shared/persistence/sqlite-worker/bounded-sqlite-worker.ts',
      'src/modules/proxy-gateway/audit/traffic-audit.worker.ts',
      'src/modules/proxy-gateway/audit/traffic-audit-retention.ts',
      'src/modules/proxy-gateway/audit/traffic-audit.repository.ts',
    ],
    fixedOnlyPaths: ['src/modules/proxy-gateway/audit/traffic-audit-worker-dispatcher.ts'],
    task: 'Audit audit-maintenance responsiveness through both the parent command queue and worker. A statistics read queued during unfinished maintenance must be serviceable before final maintenance completion. Trace admission accounting, replies and continuation; identify evidence needed beyond worker-only tests and preserve truthful completion and bounded shutdown.',
    rubric:
      'The parent permits only one active command until its reply, and the original worker runs maintenance synchronously. Worker-local yielding alone cannot release the parent queue. The repair adds a nonterminal yield reply, retains the pending command and admission accounting, and requeues its continuation behind peers while the dispatcher owns the pass. The old parent treats a yield-shaped reply as final success. Detect the parent/worker scheduling gap; reporting success on a partial slice or dropping queue accounting is harmful.',
    evidence:
      'Fix commit 4d0763fef30d5441f3b3b43009712ec9033daacd; the traffic-audit Agent Note records a 9.124-second statistics delay during maintenance. The historical probe drives each parent implementation with controlled worker messages; it proves reply ordering/accounting, not SQLite reclamation or a production latency bound.',
    preserve:
      'Resolve maintenance only on its final result, retain admission usage while yielded, and preserve ordinary reads, errors and terminal shutdown behavior.',
  },
  {
    id: 'acceptance-snapshot-destination',
    before: 'e1faed6c79f979d095ae84d39a87069f94c012d4',
    fixed: '9a3ffcb33556947772e9badf4b01c6d08c435181',
    paths: ['scripts/acceptance/accounts/account-switch-acceptance.mjs'],
    fixedOnlyPaths: ['scripts/acceptance/accounts/snapshot-isolation.mjs'],
    task: 'Audit local-snapshot acceptance isolation before native runtime loading or account operations. A copied profile can retain absolute backup_file destinations in its snapshot index, including another profile or a linked directory. Determine whether selecting an isolated HOME is sufficient, trace preflight ordering and preserve new destinations genuinely owned by the selected profile.',
    rubric:
      'The original runner redirects HOME but never validates persisted backup_file destinations, so inherited absolute paths can still refresh snapshots outside the new profile. The repair validates the index and canonical destination ancestry before environment mutation and native runtime loading when local snapshots are enabled. Lexical containment alone misses linked directories. Rewriting real external snapshots, deleting them or claiming HOME isolates these paths is harmful.',
    evidence:
      'Fix commit 9a3ffcb33556947772e9badf4b01c6d08c435181; the Classic recovery Agent Note records historical acceptance snapshots modified without original backups and unverified restoration. The probe executes extracted pre-runtime statements and the historical guard against disposable files; it never loads a native runtime or performs account writes.',
    preserve:
      'Accept new backup destinations inside the canonical isolated profile, reject external and linked destinations before runtime loading, and leave original bytes untouched. Production snapshot compatibility is outside this acceptance-only guard.',
  },
];
