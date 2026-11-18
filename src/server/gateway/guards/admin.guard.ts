import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { getServerConfig } from '../../server-config';
import { extractApiKeyToken, type RequestHeaders } from './api-key-auth.util';
import { hasConfiguredApiKey } from '@/shared/security/api-key';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const config = getServerConfig();
    const apiKey = config?.api_key;

    if (!hasConfiguredApiKey(apiKey)) {
      throw new UnauthorizedException('Admin API key is not configured');
    }

    const request = context.switchToHttp().getRequest<{ headers: RequestHeaders }>();
    const clientToken = extractApiKeyToken(request.headers);

    if (clientToken && clientToken === apiKey) {
      return true;
    }

    throw new UnauthorizedException('API key validation failed');
  }
}
