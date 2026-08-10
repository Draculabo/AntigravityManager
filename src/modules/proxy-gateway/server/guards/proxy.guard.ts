import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { getServerConfig } from '../../../../server/server-config';
import { extractApiKeyToken, hasConfiguredApiKey, RequestHeaders } from './api-key-auth.util';
import { openCodeCredentialService } from '../../opencode-sync/opencode-credentials';

@Injectable()
export class ProxyGuard implements CanActivate {
  private readonly logger = new Logger(ProxyGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    const config = getServerConfig();

    // 1. Check for API Key in config
    const apiKey = config?.api_key;

    const headers = request.headers as RequestHeaders;
    const clientToken = extractApiKeyToken(headers);

    // The OpenCode credential is accepted only by this model-proxy guard.
    // AdminGuard intentionally knows nothing about it, so revocation and scope stay independent.
    if (openCodeCredentialService.matches(clientToken)) {
      return true;
    }

    // 2. Bypass if no api_key set (Open Mode) or config missing
    if (!hasConfiguredApiKey(apiKey)) {
      return true;
    }

    if (clientToken === apiKey) {
      return true;
    }
    this.logger.warn(`Rejected unauthorized request from ${request.ip}`);

    throw new UnauthorizedException('API key validation failed');
  }
}
