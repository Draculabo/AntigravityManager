import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function dshProfilePath(profile: string): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return join(resolve(home), 'profiles', profile, 'cordis.patch.yml');
}
