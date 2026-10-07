import { os, type RouterClient } from '@orpc/server';
import { z } from 'zod';
import { ReleaseTagSchema } from '@/modules/app-shell/update/releaseNotes.schema';

export const PreviewConfigurationSchema = z.strictObject({
  mode: z.enum(['ready', 'empty', 'retry', 'slow', 'live']),
  state: z.enum(['available', 'downloading', 'downloaded']),
  tagName: ReleaseTagSchema,
});
export type PreviewConfiguration = z.infer<typeof PreviewConfigurationSchema>;
export const PreviewStatusSchema = z.strictObject({
  configuration: PreviewConfigurationSchema,
  reads: z.number().int().nonnegative(),
  downloads: z.number().int().nonnegative(),
  installs: z.number().int().nonnegative(),
  cancellations: z.number().int().nonnegative(),
});
export const previewContract = {
  configure: os.input(PreviewConfigurationSchema).output(PreviewStatusSchema),
  status: os.output(PreviewStatusSchema),
};
export type PreviewClient = RouterClient<{
  preview: {
    configure: ReturnType<typeof previewContract.configure.handler>;
    status: ReturnType<typeof previewContract.status.handler>;
  };
}>;

export const SAMPLE_NOTES = `# Local release preview

## Features

- Read changes before installing an update.
- Keep downloading while inspecting this description.
- Preserve the original language: 中文更新说明。

| Area | Result |
| --- | --- |
| Update notice | On-demand details |
| Retrieval | Exact target version |

\`\`\`typescript
const target = 'v1.2.3';
\`\`\`

### References

- [Pull request](https://github.com/Draculabo/AntigravityManager/pull/1)
- [Contributor](https://github.com/Draculabo)
- [Unapproved destination](https://example.com/blocked)
- ![Image retained as text](https://example.com/never-load-this.png)

<script>window.remoteScriptExecuted = true</script>

${Array.from({ length: 24 }, (_, index) => `### Detail ${index + 1}\n\nLong descriptions remain scrollable without moving the dialog actions.`).join('\n\n')}
`;
