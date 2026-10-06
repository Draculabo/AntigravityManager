import type { ComponentProps } from 'react';
import { CloudAccountCard } from './CloudAccountCard';
import { useAccountSelection } from '../stores/AccountSelectionProvider';

type SelectableCloudAccountCardProps = Omit<
  ComponentProps<typeof CloudAccountCard>,
  'isSelected' | 'onToggleSelection'
>;

export function SelectableCloudAccountCard(props: SelectableCloudAccountCardProps) {
  const isSelected = useAccountSelection((state) => state.selectedIds.has(props.account.id));
  const setSelected = useAccountSelection((state) => state.setSelected);
  return <CloudAccountCard {...props} isSelected={isSelected} onToggleSelection={setSelected} />;
}
