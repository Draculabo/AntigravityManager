import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { getServerConfig } from '../../../../server/server-config';
import { extractApiKeyToken, type RequestHeaders } from './api-key-auth.util';
import { hasConfiguredApiKey } from '@/shared/security/api-key';
import { openCodeCredentialService } from '../../opencode-sync/opencode-credentials';
import { buildAuthErrorBody, resolveAuthErrorSurface } from '../common/auth-error-envelope';
import { evaluateClientAddress } from '@/shared/network/client-address';

@Injectable()
export class ProxyGuard implements CanActivate {
  private readonly logger = new Logger(ProxyGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: RequestHeaders; ip: string; url?: string }>();

    return this.authorizeRequest(request);
  }

  /** Shared with compressed-body admission, which runs before Nest guards. */
  authorizeRequest(request: { headers: RequestHeaders; ip: string; url?: string }): true {
    const config = getServerConfig();
    if (config) {
      const decision = evaluateClientAddress(request.ip, request.headers, config.network);
      if (!decision.allowed) {
        throw new ForbiddenException('Request source is not allowed');
      }
    }

    // 1. Check for API Key in config
    const apiKey = config?.api_key;

    const clientToken = extractApiKeyToken(request.headers);

    // The OpenCode credential is accepted only by this model-proxy guard.
    // AdminGuard intentionally knows nothing about it, so revocation and scope stay independent.
    // OpenCode is optional: a keyring failure must not block the configured proxy API key.
    try {
      if (openCodeCredentialService.matches(clientToken)) {
        return true;
      }
    } catch (error) {
      this.logger.warn(
        `OpenCode credential check failed; continuing with proxy API key auth (${request.ip})`,
        error instanceof Error ? error.stack : undefined,
      );
    }

    // 2. Bypass if no api_key set (Open Mode) or config missing
    if (!hasConfiguredApiKey(apiKey)) {
      return true;
    }

    if (clientToken === apiKey) {
      return true;
    }
    this.logger.warn(`Rejected unauthorized request from ${request.ip}`);

    const surface = resolveAuthErrorSurface(request);
    throw new UnauthorizedException(buildAuthErrorBody(surface, 'API key validation failed'));
  }
}
