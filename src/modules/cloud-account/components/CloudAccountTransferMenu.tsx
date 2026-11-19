import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, DatabaseZap, FileDown, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { useExportCloudAccounts, useImportCloudAccounts } from '../hooks/useCloudAccounts';
import {
  LocalAccountImportDialog,
  type LocalAccountImportDialogHandle,
} from '../local-import/components/LocalAccountImportDialog';
import { readCloudAccountFileErrorCode } from '../services/cloud-account-file.schema';

export function CloudAccountTransferMenu() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [fileDialog, setFileDialog] = useState<'import' | 'export' | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const localImportDialog = useRef<LocalAccountImportDialogHandle>(null);
  const launchingDialog = useRef(false);
  const [importStrategy, setImportStrategy] = useState<'merge' | 'overwrite' | 'skip-existing'>(
    'merge',
  );
  const exportMutation = useExportCloudAccounts();
  const importMutation = useImportCloudAccounts();

  const fileErrorMessage = (error: unknown) =>
    t(`cloud.exportImport.file-errors.${readCloudAccountFileErrorCode(error) ?? 'import-failed'}`);

  const handleExport = async (stripTokens: boolean) => {
    try {
      const result = await exportMutation.mutateAsync({ stripTokens });
      if (result.status === 'cancelled') {
        return;
      }
      setFileDialog(null);
      toast({ title: t('cloud.exportImport.exportSuccess') });
    } catch (error) {
      toast({
        error,
        title: t('cloud.error.loadFailed'),
        description: fileErrorMessage(error),
        variant: 'destructive',
      });
    }
  };

  const handleImport = () => {
    importMutation.mutate(
      { strategy: importStrategy },
      {
        onSuccess: (result) => {
          if (result.status === 'cancelled') {
            return;
          }
          setFileDialog(null);
          setImportStrategy('merge');
          toast({ title: t('cloud.exportImport.importSuccess', result) });
          if (result.failed > 0) {
            toast({
              title: t('cloud.exportImport.importErrors', { count: result.failed }),
              description: result.errors
                .slice(0, 3)
                .map((error) =>
                  [error.email, t(`cloud.exportImport.file-errors.${error.code}`)]
                    .filter(Boolean)
                    .join(': '),
                )
                .join('\n'),
              variant: 'destructive',
            });
          }
        },
        onError: (error) => {
          toast({
            error,
            title: t('cloud.error.loadFailed'),
            description: fileErrorMessage(error),
            variant: 'destructive',
          });
        },
      },
    );
  };

  const openDialog = (open: () => void) => {
    launchingDialog.current = true;
    open();
  };

  const restoreMenuFocus = (event: Event) => {
    event.preventDefault();
    menuButton.current?.focus();
  };

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button ref={menuButton} variant="outline">
            {t('cloud.exportImport.transfer-menu')}
            <ChevronDown className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (launchingDialog.current) {
              event.preventDefault();
              launchingDialog.current = false;
            }
          }}
        >
          <DropdownMenuItem
            className="gap-2"
            onSelect={() => openDialog(() => localImportDialog.current?.open())}
          >
            <DatabaseZap className="size-4" aria-hidden="true" />
            {t('cloud.localImport.trigger')}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2"
            onSelect={() => openDialog(() => setFileDialog('import'))}
          >
            <Upload className="size-4" aria-hidden="true" />
            {t('cloud.exportImport.import-from-file')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2"
            onSelect={() => openDialog(() => setFileDialog('export'))}
          >
            <FileDown className="size-4" aria-hidden="true" />
            {t('cloud.exportImport.exportTitle')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <LocalAccountImportDialog ref={localImportDialog} onCloseAutoFocus={restoreMenuFocus} />
      <Dialog
        open={fileDialog === 'export'}
        onOpenChange={(open) => {
          if (!open) {
            setFileDialog(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-[500px]" onCloseAutoFocus={restoreMenuFocus}>
          <DialogHeader className="pr-8">
            <DialogTitle>{t('cloud.exportImport.exportTitle')}</DialogTitle>
            <DialogDescription>{t('cloud.exportImport.exportDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center sm:space-x-0">
            <Button
              variant="outline"
              onClick={() => handleExport(false)}
              disabled={exportMutation.isPending}
              className="w-full sm:flex-1"
              aria-busy={exportMutation.isPending}
            >
              {exportMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('cloud.exportImport.includeTokens')}
            </Button>
            <Button
              onClick={() => handleExport(true)}
              disabled={exportMutation.isPending}
              className="w-full sm:flex-1"
              aria-busy={exportMutation.isPending}
            >
              {exportMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('cloud.exportImport.stripTokens')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={fileDialog === 'import'}
        onOpenChange={(open) => {
          if (!open) {
            setFileDialog(null);
            setImportStrategy('merge');
          }
        }}
      >
        <DialogContent className="sm:max-w-[500px]" onCloseAutoFocus={restoreMenuFocus}>
          <DialogHeader className="pr-8">
            <DialogTitle>{t('cloud.exportImport.importTitle')}</DialogTitle>
            <DialogDescription>{t('cloud.exportImport.importDesc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="cloud-import-strategy">
                {t('cloud.exportImport.importStrategy')}
              </Label>
              <Select
                value={importStrategy}
                onValueChange={(value) => {
                  if (value === 'merge' || value === 'overwrite' || value === 'skip-existing') {
                    setImportStrategy(value);
                  }
                }}
              >
                <SelectTrigger id="cloud-import-strategy">
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
            <DialogClose asChild>
              <Button variant="outline">{t('common.close', 'Close')}</Button>
            </DialogClose>
            <Button
              onClick={handleImport}
              disabled={importMutation.isPending}
              aria-busy={importMutation.isPending}
            >
              {importMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {importMutation.isPending
                ? t('cloud.exportImport.importing')
                : t('cloud.exportImport.import')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
