import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { IdeEdition } from '@/types/config';
import { cn } from '@/lib/utils';

interface EditionSelectionDialogProps {
  open: boolean;
  onSelect: (edition: IdeEdition) => void;
}

export function EditionSelectionDialog({ open, onSelect }: EditionSelectionDialogProps) {
  const { t } = useTranslation();
  const [selectedEdition, setSelectedEdition] = useState<IdeEdition | null>(null);

  const handleConfirm = () => {
    if (selectedEdition) {
      onSelect(selectedEdition);
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-xl" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t('editionSelection.title')}</DialogTitle>
          <DialogDescription>{t('editionSelection.description')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <Card
            className={cn(
              'cursor-pointer transition-all hover:border-primary',
              selectedEdition === '1.x' && 'border-primary ring-2 ring-primary/20',
            )}
            onClick={() => setSelectedEdition('1.x')}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-sm font-bold text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                  1
                </span>
                {t('editionSelection.edition1x.name')}
              </CardTitle>
              <CardDescription>{t('editionSelection.edition1x.description')}</CardDescription>
            </CardHeader>
          </Card>

          <Card
            className={cn(
              'cursor-pointer transition-all hover:border-primary',
              selectedEdition === '2.0' && 'border-primary ring-2 ring-primary/20',
            )}
            onClick={() => setSelectedEdition('2.0')}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-100 text-sm font-bold text-purple-700 dark:bg-purple-900 dark:text-purple-300">
                  2
                </span>
                {t('editionSelection.edition20.name')}
              </CardTitle>
              <CardDescription>{t('editionSelection.edition20.description')}</CardDescription>
            </CardHeader>
          </Card>
        </div>

        <DialogFooter>
          <Button onClick={handleConfirm} disabled={!selectedEdition}>
            {t('editionSelection.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
