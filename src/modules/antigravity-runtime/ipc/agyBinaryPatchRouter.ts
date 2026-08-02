import { os } from '@orpc/server';
import { z } from 'zod';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { detectAgyCliExecutablePath } from '@/modules/antigravity-runtime/binary-patch/agyCliPathDetection';
import { patchAgyBinaryFile } from '@/modules/antigravity-runtime/binary-patch/agyBinaryPatchService';

const AgyBinaryPatchResultSchema = z.object({
  architectures: z.array(z.enum(['arm64', 'x86_64'])),
  backupPath: z.string().nullable(),
  filePath: z.string(),
  format: z.enum(['elf', 'mach-o', 'mach-o-universal', 'pe']),
  patchedOffsets: z.array(z.number().int().nonnegative()),
  status: z.enum(['already-patched', 'patched']),
});

export const agyBinaryPatchRouter = os.router({
  detectExecutable: os
    .input(z.object({ bypassConfig: z.boolean().optional() }).optional())
    .output(z.string())
    .handler(async ({ input }) => {
      const config = ConfigManager.getCachedConfig() ?? ConfigManager.loadConfig();
      const executablePath = detectAgyCliExecutablePath({
        bypassConfig: input?.bypassConfig,
        configuredPath: config.antigravity_cli_executable,
      });

      if (!executablePath) {
        throw new Error('Unable to locate the Antigravity CLI (agy) executable.');
      }

      return executablePath;
    }),

  patchConfigured: os.output(AgyBinaryPatchResultSchema).handler(async () => {
    const config = ConfigManager.getCachedConfig() ?? ConfigManager.loadConfig();
    const configuredPath = config.antigravity_cli_executable;
    if (!configuredPath) {
      throw new Error('Configure the Antigravity CLI executable path before patching.');
    }

    return patchAgyBinaryFile(configuredPath);
  }),
});
