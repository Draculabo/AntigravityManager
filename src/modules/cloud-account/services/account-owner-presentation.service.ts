import { CloudMonitorService } from './CloudMonitorService';
import { AutoSwitchService } from './AutoSwitchService';
import { switchCloudAccountCore } from './cloud-account-switch.service';
import { accountOwnerEvents } from './account-owner-events.service';
import { collectCloudMonitorAlerts } from './cloud-monitor-alerts.service';

/** Standalone composition publishes bounded hints; Electron renders them separately. */
export function configureCoreOwnerPresentation(): void {
  CloudMonitorService.configureEffects({
    onQuotaUpdated: (accounts) => {
      for (const event of collectCloudMonitorAlerts(accounts)) {
        accountOwnerEvents.publish(event);
      }
    },
  });
  AutoSwitchService.configureEffects({
    switchAccount: (accountId, target) =>
      switchCloudAccountCore(accountId, target, { presentationReason: 'auto' }),
    onSwitched: () => {},
  });
}
