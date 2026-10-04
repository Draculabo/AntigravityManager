import { collectCloudMonitorAlerts } from '../services/cloud-monitor-alerts.service';
import { getDesktopPreferencesLanguage } from '@/modules/config/ipc/desktop-preferences';
import type { AccountOwnerEventDraft } from '../services/account-owner-events.schema';
import type { CloudAccountView } from '../services/cloud-account-view';
import { updateTrayMenu } from '@/modules/app-shell/ipc/tray/handler';
import { Notification } from 'electron';
import type { CloudAccount } from '../types';
import { CloudMonitorService } from '../services/CloudMonitorService';
import { AutoSwitchService } from '../services/AutoSwitchService';
import { switchCloudAccountForDesktop } from './cloud-account-switch-desktop';
type CloudMonitorLanguage = 'en' | 'zh-CN' | 'ru' | 'vi' | 'fr' | 'tr';

const CLOUD_MONITOR_NOTIFICATION_TEXT: Record<
  CloudMonitorLanguage,
  {
    lowQuotaTitle: string;
    lowQuotaBody: (email: string, models: string) => string;
    lowAICreditsTitle: string;
    lowAICreditsBody: (email: string, credits: number) => string;
  }
> = {
  en: {
    lowQuotaTitle: 'Low Quota Alert',
    lowQuotaBody: (email, models) => `${email}: ${models} are low on quota`,
    lowAICreditsTitle: 'Low AI Credits Alert',
    lowAICreditsBody: (email, credits) => `${email}: AI credits balance is low (${credits})`,
  },
  'zh-CN': {
    lowQuotaTitle: '额度不足提醒',
    lowQuotaBody: (email, models) => `${email}：${models} 的额度较低`,
    lowAICreditsTitle: 'AI 积分不足提醒',
    lowAICreditsBody: (email, credits) => `${email}：AI 积分余额不足（${credits}）`,
  },
  ru: {
    lowQuotaTitle: 'Предупреждение о низкой квоте',
    lowQuotaBody: (email, models) => `${email}: низкая квота у ${models}`,
    lowAICreditsTitle: 'Предупреждение о низком балансе AI-кредитов',
    lowAICreditsBody: (email, credits) => `${email}: низкий баланс AI-кредитов (${credits})`,
  },
  vi: {
    lowQuotaTitle: 'Cảnh báo quota thấp',
    lowQuotaBody: (email, models) => `${email}: ${models} đang có quota thấp`,
    lowAICreditsTitle: 'Cảnh báo số dư tín dụng AI thấp',
    lowAICreditsBody: (email, credits) => `${email}: số dư tín dụng AI thấp (${credits})`,
  },
  fr: {
    lowQuotaTitle: 'Alerte de quota faible',
    lowQuotaBody: (email, models) => `${email} : quota faible pour ${models}`,
    lowAICreditsTitle: 'Alerte de crédits IA faibles',
    lowAICreditsBody: (email, credits) => `${email} : solde de crédits IA faible (${credits})`,
  },
  tr: {
    lowQuotaTitle: 'Düşük Kota Uyarısı',
    lowQuotaBody: (email, models) => `${email}: ${models} için kota düşük`,
    lowAICreditsTitle: 'Düşük AI Kredisi Uyarısı',
    lowAICreditsBody: (email, credits) => `${email}: AI kredi bakiyesi düşük (${credits})`,
  },
};

export function presentAccountOwnerEvent(
  event: AccountOwnerEventDraft,
  views: Array<Pick<CloudAccountView, 'id' | 'email' | 'quota' | 'is_active'>>,
): void {
  const account = views.find((view) => view.id === event.accountId);
  if (!account) {
    return;
  }
  if (event.kind === 'account-switched') {
    // Historical switch hints must not replace the current owner snapshot in the tray.
    updateTrayMenu(views.find((view) => view.is_active) ?? account);
    if (event.reason === 'auto') {
      showAutoSwitch(account.email);
    }
    return;
  }
  const language = getDesktopPreferencesLanguage(event.language);
  const resolved =
    language === 'en' ||
    language === 'zh-CN' ||
    language === 'ru' ||
    language === 'vi' ||
    language === 'fr' ||
    language === 'tr'
      ? language
      : event.language;
  const text = CLOUD_MONITOR_NOTIFICATION_TEXT[resolved];
  if (event.kind === 'low-quota') {
    const models = event.models.map(
      (model) =>
        account.quota?.models[model]?.display_name ||
        model.replace('models/', '').replace(/-/g, ' '),
    );
    new Notification({
      title: text.lowQuotaTitle,
      body: text.lowQuotaBody(account.email, models.join(', ')),
      silent: false,
    }).show();
  } else {
    new Notification({
      title: text.lowAICreditsTitle,
      body: text.lowAICreditsBody(account.email, event.credits),
      silent: false,
    }).show();
  }
}

function showQuotaAlerts(accounts: CloudAccount[]): void {
  for (const event of collectCloudMonitorAlerts(accounts)) {
    presentAccountOwnerEvent(event, accounts);
  }
}

function showAutoSwitch(email: string): void {
  new Notification({
    title: 'Antigravity Manager: Auto-Switch',
    body: `Switched account to ${email} due to quota limit. Reopen IDE and type "continue" if needed!`,
  }).show();
}

export function configureDesktopCloudMonitorEffects(): void {
  CloudMonitorService.configureEffects({ onQuotaUpdated: showQuotaAlerts });
  AutoSwitchService.configureEffects({
    switchAccount: switchCloudAccountForDesktop,
    onSwitched: (_accountId, email) => showAutoSwitch(email),
  });
}
