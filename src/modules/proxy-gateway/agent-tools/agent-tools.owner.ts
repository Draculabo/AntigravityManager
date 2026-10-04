import { homedir } from 'node:os';
import { serviceConfigService } from '@/modules/config/service-config.service';
import { detectAgentToolInstallation } from '../opencode-sync/opencode-installation';
import { AgentToolsService } from './agent-tools.service';
import { AgentToolError } from './agent-tools.schema';

export const agentToolsOwner = new AgentToolsService({
  home: homedir(),
  env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME },
  key: async () => (await serviceConfigService.revealSecret('api-key')).value,
  detect: detectAgentToolInstallation,
  ensureReviewRoute: async (model) => {
    if (model === 'codex-auto-review') {
      throw new AgentToolError('invalid-config');
    }
    const state = await serviceConfigService.ensureModelAlias('codex-auto-review', model);
    if (state === 'disabled') {
      throw new AgentToolError('review-route-disabled');
    }
  },
});
