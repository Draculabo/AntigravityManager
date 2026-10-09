import { readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const Server = z.object({
  command: z.string(),
  args: z.array(z.string()),
  env: z.unknown().optional(),
  url: z.unknown().optional(),
  headers: z.unknown().optional(),
});
const Profile = z.object({ mcpServers: z.record(z.string(), z.unknown()) });

/** Use existing credential-free local servers; npm discovery must not download dependencies. */
export async function prepareClientMcpConfig(directory: string): Promise<string> {
  const profilePath = path.join(os.homedir(), '.claude.json');
  if ((await stat(profilePath)).size > 4_194_304) {
    throw new Error('Client MCP profile is oversized');
  }
  const profileText = await readFile(profilePath, 'utf8');
  const profile = Profile.parse(JSON.parse(profileText));
  const servers: Record<string, { command: string; args: string[] }> = {};
  for (const name of ['codegraph', 'memory', 'sequential-thinking']) {
    const server = Server.parse(profile.mcpServers[name]);
    if (server.env || server.url || server.headers) {
      throw new Error('Schema sampling only accepts credential-free local MCP servers');
    }
    if (name === 'codegraph') {
      if (server.command !== 'codegraph' || server.args.join(' ') !== 'serve --mcp') {
        throw new Error('Configured CodeGraph startup differs from the inspected local server');
      }
      servers[name] = { command: server.command, args: server.args };
    } else {
      const expected = `@modelcontextprotocol/server-${name}`;
      if (
        server.command.toLowerCase() !== 'cmd' ||
        server.args.join(' ') !== `/c npx -y ${expected}`
      ) {
        throw new Error('Configured MCP package startup differs from the inspected local server');
      }
      servers[name] = { command: 'cmd', args: ['/c', 'npx', '--offline', '-y', expected] };
    }
  }
  const configPath = path.join(directory, 'mcp-config.json');
  await writeFile(configPath, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  return configPath;
}
