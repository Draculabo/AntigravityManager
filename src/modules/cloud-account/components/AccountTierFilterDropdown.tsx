import { Filter as FilterIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AccountTierOption } from '@/modules/cloud-account/utils/account-tier-filter';

interface AccountTierFilterDropdownProps {
  options: AccountTierOption[];
  selectedKeys: Set<string>;
  hasActiveFilter: boolean;
  triggerLabel: string;
  resetLabel: string;
  getOptionLabel: (option: AccountTierOption) => string;
  onReset: () => void;
  onToggle: (tierKey: string, checked: boolean) => void;
}

export function AccountTierFilterDropdown({
  options,
  selectedKeys,
  hasActiveFilter,
  triggerLabel,
  resetLabel,
  getOptionLabel,
  onReset,
  onToggle,
}: AccountTierFilterDropdownProps) {
  return (
    <div className="flex items-center gap-1 rounded-lg border p-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={hasActiveFilter ? 'secondary' : 'ghost'}
            size="xs"
            className="h-7 max-w-36 cursor-pointer gap-1.5 px-2 text-xs"
          >
            <FilterIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{triggerLabel}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64" side="bottom" sideOffset={8}>
          <DropdownMenuItem
            disabled={!hasActiveFilter}
            className="cursor-pointer"
            onClick={onReset}
          >
            <span className="ml-6">{resetLabel}</span>
          </DropdownMenuItem>
          {options.length > 0 && <DropdownMenuSeparator />}
          {options.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.key}
              checked={selectedKeys.has(option.key)}
              className="cursor-pointer"
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => onToggle(option.key, checked === true)}
            >
              <span className="min-w-0 flex-1 truncate">{getOptionLabel(option)}</span>
              <span className="text-muted-foreground ml-2 text-xs">{option.count}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
