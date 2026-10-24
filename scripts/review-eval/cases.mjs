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
];
