import {
  Check,
  CalendarDays,
  Clock3,
  Columns2,
  Columns3,
  LayoutGrid,
  LayoutList,
  List,
  RefreshCcw,
  SortAsc,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { AccountTierFilterDropdown } from '@/modules/cloud-account/components/AccountTierFilterDropdown';
import { CloudAccountLoginDialog } from './CloudAccountLoginDialog';
import { CloudAccountFileDialogs } from './CloudAccountFileDialogs';
import { CloudAccountSelectAllButton } from './CloudAccountSelectAllButton';
import {
  CLOUD_ACCOUNT_SORT_I18N_KEYS,
  CLOUD_ACCOUNT_SORT_OPTIONS,
  type GridLayout,
} from '@/modules/cloud-account/components/CloudAccountList.constants';
import type { AccountTierOption } from '@/modules/cloud-account/utils/account-tier-filter';
import type { AccountSortKey } from '@/modules/cloud-account/utils/quota-display';
import { LocalAccountImportDialog } from '@/modules/cloud-account/local-import/components/LocalAccountImportDialog';
import type { QuotaWindow } from '@/modules/cloud-account/utils/quota-groups';
import type { QuotaGroupVisibility } from '@/modules/cloud-account/utils/quota-group-visibility';
import { QuotaGroupVisibilityMenu } from './QuotaGroupVisibilityMenu';

interface CloudAccountToolbarProps {
  visibleAccountIds: string[];
  autoSwitchEnabled: boolean | undefined;
  isSettingsLoading: boolean;
  isSetAutoSwitchPending: boolean;
  isForcePollPending: boolean;
  tierOptions: AccountTierOption[];
  effectiveSelectedTierKeySet: Set<string>;
  hasActiveTierFilter: boolean;
  tierFilterButtonLabel: string;
  currentSort: AccountSortKey;
  gridLayout: GridLayout;
  quotaWindow: QuotaWindow;
  quotaGroupVisibility: QuotaGroupVisibility;
  getTierOptionLabel: (key: string, label: string) => string;
  onToggleAutoSwitch: (checked: boolean) => void;
  onForcePoll: () => void;
  onResetTierFilter: () => void;
  onToggleTierFilter: (tierKey: string, checked: boolean) => void;
  onSortChange: (sortKey: AccountSortKey) => void;
  onUpdateGridLayout: (layout: GridLayout) => void;
  onQuotaWindowChange: (quotaWindow: QuotaWindow) => void;
  onQuotaGroupVisibilityChange: (value: QuotaGroupVisibility) => void;
}

export function CloudAccountToolbar({
  visibleAccountIds,
  autoSwitchEnabled,
  isSettingsLoading,
  isSetAutoSwitchPending,
  isForcePollPending,
  tierOptions,
  effectiveSelectedTierKeySet,
  hasActiveTierFilter,
  tierFilterButtonLabel,
  currentSort,
  gridLayout,
  quotaWindow,
  quotaGroupVisibility,
  getTierOptionLabel,
  onToggleAutoSwitch,
  onForcePoll,
  onResetTierFilter,
  onToggleTierFilter,
  onSortChange,
  onUpdateGridLayout,
  onQuotaWindowChange,
  onQuotaGroupVisibilityChange,
}: CloudAccountToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="bg-card rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 p-3">
        <div className="flex items-center gap-3 px-1 py-1">
          <div className="flex items-center gap-2">
            <Zap
              className={`h-4 w-4 ${autoSwitchEnabled ? 'text-primary' : 'text-muted-foreground'}`}
            />
            <Label
              htmlFor="auto-switch"
              className="cursor-default text-sm font-medium"
              title={t('cloud.auto-switch-description')}
            >
              {t('cloud.auto-switch-client')}
            </Label>
          </div>
          <Switch
            id="auto-switch"
            checked={!!autoSwitchEnabled}
            onCheckedChange={onToggleAutoSwitch}
            disabled={isSettingsLoading || isSetAutoSwitchPending}
          />
        </div>

        <Button
          variant="outline"
          size="icon"
          onClick={onForcePoll}
          title={t('cloud.checkQuota')}
          aria-label={t('cloud.checkQuota')}
          disabled={isForcePollPending}
          className="cursor-default"
        >
          <RefreshCcw className={`h-4 w-4 ${isForcePollPending ? 'animate-spin' : ''}`} />
        </Button>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <LocalAccountImportDialog />

          <CloudAccountFileDialogs />
          <CloudAccountLoginDialog />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
        <CloudAccountSelectAllButton visibleAccountIds={visibleAccountIds} />
        <AccountTierFilterDropdown
          options={tierOptions}
          selectedKeys={effectiveSelectedTierKeySet}
          hasActiveFilter={hasActiveTierFilter}
          triggerLabel={tierFilterButtonLabel}
          resetLabel={t('cloud.tierFilter.reset')}
          getOptionLabel={(option) => getTierOptionLabel(option.key, option.label)}
          onReset={onResetTierFilter}
          onToggle={onToggleTierFilter}
        />

        <div className="flex items-center gap-1 rounded-md border p-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 cursor-default"
                aria-label={t(CLOUD_ACCOUNT_SORT_I18N_KEYS[currentSort])}
                title={t(CLOUD_ACCOUNT_SORT_I18N_KEYS[currentSort])}
              >
                <SortAsc className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56" side="bottom" sideOffset={8}>
              {CLOUD_ACCOUNT_SORT_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option}
                  className="cursor-default"
                  onClick={() => {
                    onSortChange(option);
                  }}
                >
                  {currentSort === option && <Check className="mr-2 h-4 w-4" />}
                  <span className={currentSort === option ? '' : 'ml-6'}>
                    {t(CLOUD_ACCOUNT_SORT_I18N_KEYS[option])}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          className="ml-auto flex items-center gap-1 rounded-md border p-1"
          aria-label={t('cloud.quota-window.label')}
        >
          <Button
            variant={quotaWindow === 'both' ? 'secondary' : 'ghost'}
            aria-pressed={quotaWindow === 'both'}
            size="sm"
            className="h-7 cursor-default px-2 text-xs"
            onClick={() => onQuotaWindowChange('both')}
          >
            {t('cloud.quota-window.both-short')}
          </Button>
          <Button
            variant={quotaWindow === '5h' ? 'secondary' : 'ghost'}
            aria-pressed={quotaWindow === '5h'}
            size="sm"
            className="h-7 cursor-default px-2 text-xs"
            onClick={() => onQuotaWindowChange('5h')}
          >
            <Clock3 className="mr-1 h-3.5 w-3.5" />
            {t('cloud.quota-window.five-hours-short')}
          </Button>
          <Button
            variant={quotaWindow === 'weekly' ? 'secondary' : 'ghost'}
            aria-pressed={quotaWindow === 'weekly'}
            size="sm"
            className="h-7 cursor-default px-2 text-xs"
            onClick={() => onQuotaWindowChange('weekly')}
          >
            <CalendarDays className="mr-1 h-3.5 w-3.5" />
            {t('cloud.quota-window.weekly-short')}
          </Button>
        </div>

        <QuotaGroupVisibilityMenu
          value={quotaGroupVisibility}
          onChange={onQuotaGroupVisibilityChange}
        />

        <div className="flex items-center gap-1 rounded-md border p-1">
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={gridLayout === 'auto' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 cursor-default"
                  onClick={() => onUpdateGridLayout('auto')}
                  aria-label={t('cloud.layout.auto')}
                  aria-pressed={gridLayout === 'auto'}
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('cloud.layout.auto')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={gridLayout === '2-col' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 cursor-default"
                  onClick={() => onUpdateGridLayout('2-col')}
                  aria-label={t('cloud.layout.twoCol')}
                  aria-pressed={gridLayout === '2-col'}
                >
                  <Columns2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('cloud.layout.twoCol')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={gridLayout === '3-col' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 cursor-default"
                  onClick={() => onUpdateGridLayout('3-col')}
                  aria-label={t('cloud.layout.threeCol')}
                  aria-pressed={gridLayout === '3-col'}
                >
                  <Columns3 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('cloud.layout.threeCol')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={gridLayout === 'list' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 cursor-default"
                  onClick={() => onUpdateGridLayout('list')}
                  aria-label={t('cloud.layout.list')}
                  aria-pressed={gridLayout === 'list'}
                >
                  <List className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('cloud.layout.list')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={gridLayout === 'compact' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 cursor-default"
                  onClick={() => onUpdateGridLayout('compact')}
                  aria-label={t('cloud.layout.compact')}
                  aria-pressed={gridLayout === 'compact'}
                >
                  <LayoutList className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('cloud.layout.compact')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </div>
  );
}
