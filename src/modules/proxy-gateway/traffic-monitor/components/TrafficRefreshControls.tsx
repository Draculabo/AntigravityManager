import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { TrafficClass } from '@/modules/proxy-gateway/audit/traffic-classifier';

interface TrafficRefreshControlsProps {
  tab: TrafficClass;
  page: number;
  selectedId: string | null;
}

export function TrafficRefreshControls({ tab, page, selectedId }: TrafficRefreshControlsProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [newCount, setNewCount] = useState(0);
  useEffect(() => {
    return window.electron.onTrafficAuditEvent((event) => {
      if (event.trafficClass && event.trafficClass !== tab) {
        return;
      }
      if (page === 0 && !selectedId) {
        void queryClient.invalidateQueries({ queryKey: ['gateway', 'traffic-list', tab] });
      } else {
        setNewCount((current) => current + 1);
      }
      if (selectedId && event.id === selectedId) {
        void queryClient.invalidateQueries({ queryKey: ['gateway', 'traffic-detail', selectedId] });
      }
    });
  }, [page, queryClient, selectedId, tab]);

  const refresh = async () => {
    setNewCount(0);
    await queryClient.invalidateQueries({ queryKey: ['gateway'] });
  };
  return (
    <>
      {newCount > 0 && (
        <Button size="sm" variant="secondary" onClick={() => void refresh()}>
          {t('traffic.new-records', { count: newCount })}
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={() => void refresh()}>
        <RefreshCw className="h-4 w-4" /> {t('traffic.refresh')}
      </Button>
    </>
  );
}
