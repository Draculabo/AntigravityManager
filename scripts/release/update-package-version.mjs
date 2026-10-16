import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** Version the private desktop manifest without generating an npm lockfile or publishing. */
export async function prepare(_config, { cwd, nextRelease: { version }, logger }) {
  z.string()
    .regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/)
    .parse(version);
  const file = path.join(cwd, 'package.json');
  const manifest = z
    .looseObject({
      name: z.string(),
      version: z.string(),
      private: z.literal(true),
    })
    .parse(JSON.parse(await readFile(file, 'utf8')));
  manifest.version = version;
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
  logger.log('Write version %s to package.json', version);
}
