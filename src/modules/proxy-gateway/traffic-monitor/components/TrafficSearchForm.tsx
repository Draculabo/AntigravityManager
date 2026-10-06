import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';

export function TrafficSearchForm({
  search,
  onSubmit,
}: {
  search: string;
  onSubmit: (search: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(search);
  return (
    <form
      className="relative max-w-md min-w-56 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(draft.trim());
      }}
    >
      <Search className="text-muted-foreground absolute top-2.5 left-2.5 h-4 w-4" />
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="h-9 pl-8"
        placeholder={t('traffic.search-metadata')}
        aria-label={t('traffic.search-metadata')}
      />
    </form>
  );
}
