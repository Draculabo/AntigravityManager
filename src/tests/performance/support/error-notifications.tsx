import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import en from '@/localization/en';
import zhCN from '@/localization/zh-CN';
import { AppToaster } from '@/modules/app-shell/components/AppToaster';
import { toast, useToast } from '@/components/ui/use-toast';
import { Button } from '@/components/ui/button';
import { ThemeProvider, useTheme } from '@/components/shared/theme-provider';
import './renderer-updates.css';

const resources = {
  en: {
    translation: {
      ...en,
      'error-demo': {
        title: 'Error notification demo',
        description:
          'Production notification UI and preload with synthetic errors. No accounts are loaded.',
        instructions:
          'Choose an error, then open Details in the lower-right notification. Close it with Escape, the close icon or Close.',
        reporting:
          'Report to GitHub copies the synthetic error and real runtime versions, then opens the bug form. Review and submit it yourself.',
        stack: 'Trigger an error',
        backend: 'Backend stack',
        redaction: 'Redaction example',
        missing: 'No stack',
        success: 'Success notification',
        dismiss: 'Dismiss notification',
        theme: 'Toggle theme',
        failure: 'The demo operation failed',
        retry: 'Please retry or inspect the details.',
        noStack: 'This operation returned an error message without a stack.',
      },
    },
  },
  'zh-CN': {
    translation: {
      ...zhCN,
      'error-demo': {
        title: '错误通知体验',
        description: '使用正式通知组件和 preload，错误为合成数据，不读取账号。',
        instructions:
          '点击下面的按钮触发错误，再点击右下角通知中的“详情”。可用 Escape、右上角叉号或“关闭”退出。',
        reporting:
          '“上报到 GitHub”会复制合成错误和真实运行环境版本，并打开反馈表单。请检查内容后自行提交。',
        stack: '触发错误',
        backend: '后端堆栈',
        redaction: '脱敏示例',
        missing: '无堆栈错误',
        success: '成功通知',
        dismiss: '关闭当前通知',
        theme: '切换主题',
        failure: '演示操作失败',
        retry: '请重试，或查看错误详情。',
        noStack: '此操作只返回了错误提示，没有堆栈。',
      },
    },
  },
};
await i18next.use(initReactI18next).init({
  lng: 'zh-CN',
  fallbackLng: 'en',
  resources,
  interpolation: { escapeValue: false },
});

function Preview() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const { dismiss } = useToast();
  const [sequence, setSequence] = useState(0);
  const notify = (scenario: 'stack' | 'backend' | 'redaction' | 'missing') => {
    const next = sequence + 1;
    setSequence(next);
    let error: unknown;
    if (scenario === 'stack') {
      error = new Error(`Synthetic operation ${next} failed`);
    } else if (scenario === 'backend') {
      error = {
        message: 'IPC request failed',
        stack: 'Renderer transport stack — this should not replace the backend stack',
        data: {
          requestPath: '["demo","refresh"]',
          backendCode: 'INTERNAL_SERVER_ERROR',
          backendMessage: `Synthetic backend operation ${next} failed`,
          backendStack: `Error: Synthetic backend operation ${next} failed\n    at refreshAccount (services/accounts.ts:42:1)\n    at handleRequest (ipc/router.ts:17:3)`,
        },
      };
    } else if (scenario === 'redaction') {
      const redactionError = new Error('Synthetic credential redaction example');
      redactionError.stack = [
        'Error: Synthetic credential redaction example',
        '    at C:\\Users\\DemoUser\\app\\request.ts:42:1',
        'access_token=demo-placeholder-token',
        'Account demo@example.invalid',
        'Proxy https://demo-user:demo-password@proxy.example.invalid',
      ].join('\n');
      error = redactionError;
    }
    toast({
      variant: 'destructive',
      title: `${t('error-demo.failure')} (${next})`,
      description: t(scenario === 'missing' ? 'error-demo.noStack' : 'error-demo.retry'),
      error,
    });
  };
  return (
    <main className="bg-background text-foreground min-h-screen p-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-2xl font-semibold">{t('error-demo.title')}</h1>
        <p className="text-muted-foreground">{t('error-demo.description')}</p>
        <p>{t('error-demo.instructions')}</p>
        <div className="flex flex-wrap gap-3 rounded-lg border p-5">
          <Button onClick={() => notify('stack')}>{t('error-demo.stack')}</Button>
          <Button variant="outline" onClick={() => notify('backend')}>
            {t('error-demo.backend')}
          </Button>
          <Button variant="outline" onClick={() => notify('redaction')}>
            {t('error-demo.redaction')}
          </Button>
          <Button variant="outline" onClick={() => notify('missing')}>
            {t('error-demo.missing')}
          </Button>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button
            variant="outline"
            onClick={() => toast({ variant: 'success', title: t('error-demo.success') })}
          >
            {t('error-demo.success')}
          </Button>
          <Button variant="outline" onClick={() => dismiss()}>
            {t('error-demo.dismiss')}
          </Button>
          <Button variant="outline" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {t('error-demo.theme')}
          </Button>
        </div>
        <p className="text-muted-foreground rounded-lg border p-5 text-sm leading-relaxed">
          {t('error-demo.reporting')}
        </p>
      </div>
      <AppToaster />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <ThemeProvider defaultTheme="light" storageKey="error-notification-demo-theme">
    <Preview />
  </ThemeProvider>,
);
