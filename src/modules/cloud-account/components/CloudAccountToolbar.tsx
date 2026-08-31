import type { ChangeEvent, RefObject } from 'react';
import {
  Check,
  CheckSquare,
  CalendarDays,
  Cloud,
  Clock3,
  Columns2,
  Columns3,
  Download,
  FileDown,
  LayoutGrid,
  LayoutList,
  List,
  Loader2,
  Plus,
  RefreshCcw,
  SortAsc,
  Upload,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { AccountTierFilterDropdown } from '@/modules/cloud-account/components/AccountTierFilterDropdown';
import {
  CLOUD_ACCOUNT_SORT_I18N_KEYS,
  CLOUD_ACCOUNT_SORT_OPTIONS,
  type GridLayout,
} from '@/modules/cloud-account/components/CloudAccountList.constants';
import type { OAuthClientDescriptor } from '@/modules/cloud-account/actions/cloud';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import type { AccountTierOption } from '@/modules/cloud-account/utils/account-tier-filter';
import type { AccountSortKey } from '@/modules/cloud-account/utils/quota-display';
import { LocalAccountImportDialog } from '@/modules/cloud-account/local-import/components/LocalAccountImportDialog';
import type { QuotaWindow } from '@/modules/cloud-account/utils/quota-groups';

type ImportStrategy = 'merge' | 'overwrite' | 'skip-existing';

interface CloudAccountToolbarProps {
  autoSwitchEnabled: boolean | undefined;
  isSettingsLoading: boolean;
  isSetAutoSwitchPending: boolean;
  isForcePollPending: boolean;
  isSyncPending: boolean;
  allVisibleSelected: boolean;
  selectedCount: number;
  isExportDialogOpen: boolean;
  isImportDialogOpen: boolean;
  isAddDialogOpen: boolean;
  isExportPending: boolean;
  isImportPending: boolean;
  isAddPending: boolean;
  isOAuthClientsLoading: boolean;
  isSetActiveOAuthClientPending: boolean;
  importStrategy: ImportStrategy;
  importFileContent: string | null;
  importFileName: string;
  authCode: string;
  selectedOAuthClientKey: string;
  oauthClients: OAuthClientDescriptor[];
  fileInputRef: RefObject<HTMLInputElement | null>;
  tierOptions: AccountTierOption[];
  effectiveSelectedTierKeySet: Set<string>;
  hasActiveTierFilter: boolean;
  tierFilterButtonLabel: string;
  currentSort: AccountSortKey;
  gridLayout: GridLayout;
  quotaWindow: QuotaWindow;
  getTierOptionLabel: (key: string, label: string) => string;
  onToggleAutoSwitch: (checked: boolean) => void;
  onToggleSelectAllAccounts: () => void;
  onForcePoll: () => void;
  onSyncLocal: (appTarget: AntigravityAppTarget) => void;
  onExportDialogOpenChange: (open: boolean) => void;
  onImportDialogOpenChange: (open: boolean) => void;
  onAddDialogOpenChange: (open: boolean) => void;
  onExport: (stripTokens: boolean) => void;
  onImportFileSelect: (event: ChangeEvent<HTMLInputElement>) => void;
  onImportStrategyChange: (strategy: ImportStrategy) => void;
  onImport: () => void;
  onOAuthClientChange: (clientKey: string) => void;
  onOpenGoogleAuthSignIn: () => void;
  onAuthCodeChange: (authCode: string) => void;
  onSubmitAuthCode: () => void;
  onResetTierFilter: () => void;
  onToggleTierFilter: (tierKey: string, checked: boolean) => void;
  onSortChange: (sortKey: AccountSortKey) => void;
  onUpdateGridLayout: (layout: GridLayout) => void;
  onQuotaWindowChange: (quotaWindow: QuotaWindow) => void;
}

export function CloudAccountToolbar({
  autoSwitchEnabled,
  isSettingsLoading,
  isSetAutoSwitchPending,
  isForcePollPending,
  isSyncPending,
  allVisibleSelected,
  selectedCount,
  isExportDialogOpen,
  isImportDialogOpen,
  isAddDialogOpen,
  isExportPending,
  isImportPending,
  isAddPending,
  isOAuthClientsLoading,
  isSetActiveOAuthClientPending,
  importStrategy,
  importFileContent,
  importFileName,
  authCode,
  selectedOAuthClientKey,
  oauthClients,
  fileInputRef,
  tierOptions,
  effectiveSelectedTierKeySet,
  hasActiveTierFilter,
  tierFilterButtonLabel,
  currentSort,
  gridLayout,
  quotaWindow,
  getTierOptionLabel,
  onToggleAutoSwitch,
  onToggleSelectAllAccounts,
  onForcePoll,
  onSyncLocal,
  onExportDialogOpenChange,
  onImportDialogOpenChange,
  onAddDialogOpenChange,
  onExport,
  onImportFileSelect,
  onImportStrategyChange,
  onImport,
  onOAuthClientChange,
  onOpenGoogleAuthSignIn,
  onAuthCodeChange,
  onSubmitAuthCode,
  onResetTierFilter,
  onToggleTierFilter,
  onSortChange,
  onUpdateGridLayout,
  onQuotaWindowChange,
}: CloudAccountToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="bg-card flex flex-wrap items-center gap-2 rounded-lg border p-3">
      <div className="bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-2">
        <div className="flex items-center gap-2">
          <Zap
            className={`h-4 w-4 ${autoSwitchEnabled ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground'}`}
          />
          <Label htmlFor="auto-switch" className="cursor-pointer text-sm font-medium">
            {t('cloud.autoSwitch')}
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
        variant="ghost"
        onClick={onToggleSelectAllAccounts}
        title={t('cloud.batch.selectAll')}
        className="cursor-pointer"
      >
        <CheckSquare
          className={`mr-2 h-4 w-4 ${selectedCount > 0 && allVisibleSelected ? 'text-primary fill-primary/20' : ''}`}
        />
        {t('cloud.batch.selectAll')}
      </Button>

      <Button
        variant="outline"
        size="icon"
        onClick={onForcePoll}
        title={t('cloud.checkQuota')}
        disabled={isForcePollPending}
        className="cursor-pointer"
      >
        <RefreshCcw className={`h-4 w-4 ${isForcePollPending ? 'animate-spin' : ''}`} />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            disabled={isSyncPending}
            title={t('cloud.syncFromIde')}
            className="cursor-pointer"
          >
            <Download className={`mr-2 h-4 w-4 ${isSyncPending ? 'animate-bounce' : ''}`} />
            {t('cloud.syncFromIde')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56" side="bottom" sideOffset={8}>
          <DropdownMenuLabel className="text-muted-foreground px-2 py-1.5 text-[10px] tracking-wider uppercase">
            {t('cloud.syncSource', 'Sync Source')}
          </DropdownMenuLabel>
          <DropdownMenuItem
            className="cursor-pointer"
            disabled={isSyncPending}
            onClick={() => onSyncLocal('classic')}
          >
            {t('cloud.syncFromAntigravity', 'Antigravity')}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer"
            disabled={isSyncPending}
            onClick={() => onSyncLocal('ide')}
          >
            {t('cloud.syncFromAntigravityIde', 'Antigravity IDE')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <LocalAccountImportDialog />

      <Dialog open={isExportDialogOpen} onOpenChange={onExportDialogOpenChange}>
        <DialogTrigger asChild>
          <Button variant="outline" className="cursor-pointer">
            <FileDown className="mr-2 h-4 w-4" />
            {t('cloud.exportImport.export')}
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{t('cloud.exportImport.exportTitle')}</DialogTitle>
            <DialogDescription>{t('cloud.exportImport.exportDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center sm:space-x-0">
            <Button
              variant="outline"
              onClick={() => onExport(false)}
              disabled={isExportPending}
              className="w-full cursor-pointer sm:flex-1"
            >
              {isExportPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('cloud.exportImport.includeTokens')}
            </Button>
            <Button
              onClick={() => onExport(true)}
              disabled={isExportPending}
              className="w-full cursor-pointer sm:flex-1"
            >
              {isExportPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('cloud.exportImport.stripTokens')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isImportDialogOpen} onOpenChange={onImportDialogOpenChange}>
        <DialogTrigger asChild>
          <Button variant="outline" className="cursor-pointer">
            <Upload className="mr-2 h-4 w-4" />
            {t('cloud.exportImport.import')}
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{t('cloud.exportImport.importTitle')}</DialogTitle>
            <DialogDescription>{t('cloud.exportImport.importDesc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>{t('cloud.exportImport.selectFile')}</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={onImportFileSelect}
                className="hidden"
              />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                className="cursor-pointer"
              >
                {importFileName || t('cloud.exportImport.selectFile')}
              </Button>
            </div>
            <div className="grid gap-2">
              <Label>{t('cloud.exportImport.importStrategy')}</Label>
              <Select value={importStrategy} onValueChange={onImportStrategyChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="merge">{t('cloud.exportImport.strategyMerge')}</SelectItem>
                  <SelectItem value="overwrite">
                    {t('cloud.exportImport.strategyOverwrite')}
                  </SelectItem>
                  <SelectItem value="skip-existing">
                    {t('cloud.exportImport.strategySkip')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={onImport} disabled={!importFileContent || isImportPending}>
              {isImportPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isImportPending ? t('cloud.exportImport.importing') : t('cloud.exportImport.import')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isAddDialogOpen} onOpenChange={onAddDialogOpenChange}>
        <DialogTrigger asChild>
          <Button className="cursor-pointer">
            <Plus className="mr-2 h-4 w-4" />
            {t('cloud.addAccount')}
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{t('cloud.authDialog.title')}</DialogTitle>
            <DialogDescription>{t('cloud.authDialog.description')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="oauth-client-select">{t('cloud.authDialog.oauthClient')}</Label>
              <Select
                value={selectedOAuthClientKey || undefined}
                onValueChange={onOAuthClientChange}
                disabled={isOAuthClientsLoading || isSetActiveOAuthClientPending}
              >
                <SelectTrigger id="oauth-client-select">
                  <SelectValue placeholder={t('cloud.authDialog.oauthClientPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {oauthClients.map((client) => (
                    <SelectItem key={client.key} value={client.key}>
                      {client.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Button variant="outline" className="col-span-4" onClick={onOpenGoogleAuthSignIn}>
                <Cloud className="mr-2 h-4 w-4" />
                {t('cloud.authDialog.openLogin')}
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor="code">{t('cloud.authDialog.authCode')}</Label>
              <Input
                id="code"
                placeholder={t('cloud.authDialog.placeholder')}
                value={authCode}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  onAuthCodeChange(event.target.value);
                }}
              />
              <p className="text-muted-foreground text-xs">{t('cloud.authDialog.instruction')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={onSubmitAuthCode} disabled={isAddPending || !authCode}>
              {isAddPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('cloud.authDialog.verify')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
            <Button variant="ghost" size="icon" className="h-7 w-7 cursor-pointer">
              <SortAsc className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56" side="bottom" sideOffset={8}>
            {CLOUD_ACCOUNT_SORT_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option}
                className="cursor-pointer"
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
          variant={quotaWindow === '5h' ? 'secondary' : 'ghost'}
          aria-pressed={quotaWindow === '5h'}
          size="sm"
          className="h-7 cursor-pointer px-2 text-xs"
          onClick={() => onQuotaWindowChange('5h')}
        >
          <Clock3 className="mr-1 h-3.5 w-3.5" />
          {t('cloud.quota-window.five-hours-short')}
        </Button>
        <Button
          variant={quotaWindow === 'weekly' ? 'secondary' : 'ghost'}
          aria-pressed={quotaWindow === 'weekly'}
          size="sm"
          className="h-7 cursor-pointer px-2 text-xs"
          onClick={() => onQuotaWindowChange('weekly')}
        >
          <CalendarDays className="mr-1 h-3.5 w-3.5" />
          {t('cloud.quota-window.weekly-short')}
        </Button>
      </div>

      <div className="flex items-center gap-1 rounded-md border p-1">
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={gridLayout === 'auto' ? 'secondary' : 'ghost'}
                size="icon"
                className="h-7 w-7 cursor-pointer"
                onClick={() => onUpdateGridLayout('auto')}
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
                className="h-7 w-7 cursor-pointer"
                onClick={() => onUpdateGridLayout('2-col')}
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
                className="h-7 w-7 cursor-pointer"
                onClick={() => onUpdateGridLayout('3-col')}
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
                className="h-7 w-7 cursor-pointer"
                onClick={() => onUpdateGridLayout('list')}
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
                className="h-7 w-7 cursor-pointer"
                onClick={() => onUpdateGridLayout('compact')}
              >
                <LayoutList className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('cloud.layout.compact')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}
