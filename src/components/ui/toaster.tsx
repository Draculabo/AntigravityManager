import { useToast } from '@/components/ui/use-toast';
import { CircleCheck, CircleAlert, TriangleAlert, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast';

const FEEDBACK = {
  default: { icon: Info, className: 'bg-info-soft text-info' },
  success: { icon: CircleCheck, className: 'bg-success-soft text-success' },
  warning: { icon: TriangleAlert, className: 'bg-warning-soft text-warning' },
  destructive: { icon: CircleAlert, className: 'bg-destructive/10 text-destructive' },
};

export function Toaster() {
  const { toasts } = useToast();
  const { t } = useTranslation();

  return (
    <ToastProvider label={t('settings.notifications.title')}>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        const feedback = FEEDBACK[props.variant ?? 'default'];
        const Icon = feedback.icon;
        return (
          <Toast key={id} {...props}>
            <div
              className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${feedback.className}`}
            >
              <Icon className="size-4" aria-hidden="true" />
            </div>
            <div className="grid min-w-0 flex-1 gap-1">
              {title ? <ToastTitle>{title}</ToastTitle> : null}
              {description ? <ToastDescription>{description}</ToastDescription> : null}
              {action ? <div className="mt-2">{action}</div> : null}
            </div>
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport label={`${t('settings.notifications.title')} ({hotkey})`} />
    </ToastProvider>
  );
}
