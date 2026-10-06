import { CheckSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useAccountSelection } from '../stores/AccountSelectionProvider';

export function CloudAccountSelectAllButton({
  visibleAccountIds,
}: {
  visibleAccountIds: string[];
}) {
  const { t } = useTranslation();
  const allVisibleSelected = useAccountSelection(
    (state) =>
      visibleAccountIds.length > 0 && visibleAccountIds.every((id) => state.selectedIds.has(id)),
  );
  const toggleVisible = useAccountSelection((state) => state.toggleVisible);
  return (
    <Button
      variant="ghost"
      onClick={() => toggleVisible(visibleAccountIds)}
      title={t('cloud.batch.selectAll')}
      className="cursor-pointer"
    >
      <CheckSquare
        className={`mr-2 h-4 w-4 ${allVisibleSelected ? 'text-primary fill-primary/20' : ''}`}
      />
      {t('cloud.batch.selectAll')}
    </Button>
  );
}
