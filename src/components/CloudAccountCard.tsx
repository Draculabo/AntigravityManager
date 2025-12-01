import { CloudAccount } from '@/types/cloudAccount';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Checkbox } from '@/components/ui/checkbox';

import { MoreVertical, Trash, RefreshCw, Box, Power } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';

interface CloudAccountCardProps {
  account: CloudAccount;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
  onSwitch: (id: string) => void;
  isSelected?: boolean;
  onToggleSelection?: (id: string, selected: boolean) => void;
  isRefreshing?: boolean;
  isDeleting?: boolean;
  isSwitching?: boolean;
}

export function CloudAccountCard({
  account,
  onRefresh,
  onDelete,
  onSwitch,
  isSelected = false,
  onToggleSelection,
  isRefreshing,
  isDeleting,
  isSwitching,
}: CloudAccountCardProps) {
  const { t } = useTranslation();

  // Helpers to get quota color
  const getQuotaColor = (percentage: number) => {
    if (percentage > 80) return 'text-green-500';
    if (percentage > 20) return 'text-yellow-500';
    return 'text-red-500';
  };

  const modelQuotas = Object.entries(account.quota?.models || {});

  return (
    <Card
      className={`flex flex-col overflow-hidden transition-all ${isSelected ? 'ring-primary border-primary/50 ring-2' : 'hover:border-primary/50'}`}
    >
      <CardHeader className="group relative flex flex-row items-center gap-4 space-y-0 pb-2">
        {/* Selection Checkbox - Visible on hover or selected */}
        {onToggleSelection && (
          <div
            className={`absolute top-2 left-2 z-10 ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} from-background rounded-full bg-gradient-to-br to-transparent p-2 transition-opacity`}
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={(checked) => onToggleSelection(account.id, checked as boolean)}
              className="h-5 w-5 border-2"
            />
          </div>
        )}

        {account.avatar_url ? (
          <img
            src={account.avatar_url}
            alt={account.name}
            className="bg-muted h-10 w-10 rounded-full border"
          />
        ) : (
          <div className="bg-primary/10 text-primary flex h-10 w-10 items-center justify-center rounded-full">
            {account.name?.[0]?.toUpperCase() || 'A'}
          </div>
        )}
        <div className="flex-1 overflow-hidden">
          <CardTitle className="truncate text-base font-semibold">
            {account.name || t('cloud.card.unknown')}
          </CardTitle>
          <CardDescription className="truncate text-xs">{account.email}</CardDescription>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreVertical className="h-4 w-4" />
              <span className="sr-only">Menu</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('cloud.card.actions')}</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onSwitch(account.id)} disabled={isSwitching}>
              <Power className="mr-2 h-4 w-4" />
              {t('cloud.card.useAccount')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onRefresh(account.id)} disabled={isRefreshing}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('cloud.card.refresh')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onDelete(account.id)}
              className="text-destructive focus:text-destructive"
              disabled={isDeleting}
            >
              <Trash className="mr-2 h-4 w-4" />
              {t('cloud.card.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>

      <CardContent className="flex-1 pb-2">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge
              variant={account.status === 'rate_limited' ? 'destructive' : 'outline'}
              className="text-xs"
            >
              {account.provider.toUpperCase()}
            </Badge>
            {account.is_active && (
              <Badge variant="default" className="bg-green-500 text-xs hover:bg-green-600">
                {t('cloud.card.active')}
              </Badge>
            )}
            {account.status === 'rate_limited' && (
              <span className="text-destructive text-xs font-medium">
                {t('cloud.card.rateLimited')}
              </span>
            )}
          </div>

          {account.is_active ? (
            <Button variant="ghost" size="sm" disabled className="text-green-600 opacity-100">
              <Power className="mr-1 h-3 w-3" />
              {t('cloud.card.active')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onSwitch(account.id)}
              disabled={isSwitching}
            >
              {isSwitching ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
                <Power className="mr-1 h-3 w-3" />
              )}
              {t('cloud.card.use')}
            </Button>
          )}
        </div>

        <div className="space-y-2">
          {modelQuotas.length > 0 ? (
            modelQuotas.map(([modelName, info]) => (
              <div key={modelName} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground max-w-[120px] truncate" title={modelName}>
                  {modelName.replace('models/', '')}
                </span>
                <div className="flex items-center gap-2">
                  <span className={`font-mono font-bold ${getQuotaColor(info.percentage)}`}>
                    {info.percentage}%
                  </span>
                  <span className="text-muted-foreground text-xs">{t('cloud.card.left')}</span>
                </div>
              </div>
            ))
          ) : (
            <div className="text-muted-foreground flex flex-col items-center justify-center py-4">
              <Box className="mb-2 h-8 w-8 opacity-20" />
              <span className="text-xs">{t('cloud.card.noQuota')}</span>
            </div>
          )}
        </div>
      </CardContent>

      <CardFooter className="bg-muted/50 text-muted-foreground justify-between p-2 px-4 text-xs">
        <span>
          {t('cloud.card.used')}{' '}
          {formatDistanceToNow(account.last_used * 1000, { addSuffix: true })}
        </span>
      </CardFooter>
    </Card>
  );
}
