import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConnectionProfileClientSchema } from '../connection-profiles/connection-profiles.schema';
import { GatewayToolRow } from './GatewayToolRow';

export function GatewayTools({
  baseUrl,
  quickModels,
  hasGatewayKey,
}: {
  baseUrl: string;
  quickModels: readonly string[];
  hasGatewayKey: boolean;
}) {
  const { t } = useTranslation();

  return (
    <Card className="gap-0 shadow-none">
      <CardHeader className="border-b p-4">
        <CardTitle>{t('client-config.tools-title')}</CardTitle>
        {!quickModels.length && (
          <p className="text-muted-foreground text-sm">{t('client-config.quick-no-models')}</p>
        )}
        {!hasGatewayKey && (
          <a
            className="text-primary w-fit text-sm underline-offset-4 hover:underline"
            href="#gateway-api-key"
          >
            {t('client-config.config-key-missing')}
          </a>
        )}
      </CardHeader>
      <CardContent className="divide-border divide-y p-0">
        {ConnectionProfileClientSchema.options.map((tool) => (
          <GatewayToolRow
            key={tool}
            tool={tool}
            baseUrl={baseUrl}
            models={quickModels}
            hasGatewayKey={hasGatewayKey}
          />
        ))}
      </CardContent>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-sm">
        <p className="text-muted-foreground">{t('client-config.verify-in-traffic')}</p>
        <Link
          className="text-primary underline-offset-4 hover:underline"
          to="/traffic"
          search={{ page: 0, search: '', tab: 'model' }}
        >
          {t('client-config.open-traffic')}
        </Link>
      </div>
    </Card>
  );
}
