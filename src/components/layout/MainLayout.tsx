import React, { useState, useEffect, useRef } from 'react';
import { Link, Outlet, useLocation } from '@tanstack/react-router';
import { cn } from '@/shared/ui/utils';
import { StatusBar } from '@/components/layout/StatusBar';
import {
  LayoutDashboard,
  Settings,
  Network,
  Rocket,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Activity,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ErrorBoundary } from 'react-error-boundary';
import { useToast } from '@/components/ui/use-toast';
import { getLocalizedErrorMessage } from '@/shared/utils/errorMessages';

export const MainLayout: React.FC = () => {
  const location = useLocation();
  const { t } = useTranslation();
  const { toast } = useToast();
  const hasShownRouteErrorToastRef = useRef(false);

  // Initialize state from localStorage if available, default to false (expanded)
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const saved = localStorage.getItem('sidebar-collapsed');
    return saved ? JSON.parse(saved) : false;
  });

  // Persist state changes
  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', JSON.stringify(isCollapsed));
  }, [isCollapsed]);

  const navItems = [
    {
      to: '/',
      icon: LayoutDashboard,
      label: t('nav.accounts'),
    },
    {
      to: '/proxy',
      icon: Network,
      label: t('nav.proxy'),
    },
    {
      to: '/traffic',
      icon: Activity,
      label: t('nav.traffic'),
    },
    {
      to: '/settings',
      icon: Settings,
      label: t('nav.settings'),
    },
  ];

  return (
    <div className="bg-background text-foreground flex h-screen flex-col overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside
          className={cn(
            'bg-sidebar text-sidebar-foreground border-sidebar-border flex shrink-0 flex-col border-r select-none',
            isCollapsed ? 'w-16' : 'w-56',
          )}
        >
          <div className={cn('flex flex-col py-5', isCollapsed ? 'items-center px-3' : 'px-4')}>
            <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap">
              <div className="bg-info-soft text-info border-info-border flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border">
                <Rocket className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className={cn('overflow-hidden', isCollapsed && 'hidden')}>
                <div className="text-sm font-semibold tracking-tight">Antigravity</div>
                <div className="text-muted-foreground text-xs">Manager</div>
              </div>
            </div>
          </div>

          <nav aria-label={t('nav.navigation')} className="flex-1 space-y-1 px-2">
            <TooltipProvider>
              {navItems.map((item) => {
                const isActive = location.pathname === item.to;

                if (isCollapsed) {
                  return (
                    <Tooltip key={item.to} delayDuration={0}>
                      <TooltipTrigger asChild>
                        <Link
                          to={item.to}
                          aria-current={isActive ? 'page' : undefined}
                          className={cn(
                            'focus-visible:ring-ring mx-auto flex h-10 w-10 cursor-default items-center justify-center rounded-md outline-none focus-visible:ring-2',
                            isActive
                              ? 'bg-sidebar-accent text-sidebar-accent-foreground ring-sidebar-border ring-1 ring-inset'
                              : 'hover:bg-muted text-muted-foreground hover:text-foreground',
                          )}
                        >
                          <item.icon className="h-4 w-4" aria-hidden="true" />
                          <span className="sr-only">{item.label}</span>
                        </Link>
                      </TooltipTrigger>
                      <TooltipContent side="right">{item.label}</TooltipContent>
                    </Tooltip>
                  );
                }

                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'focus-visible:ring-ring flex h-10 cursor-default items-center gap-3 rounded-md px-3 text-sm outline-none focus-visible:ring-2',
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground ring-sidebar-border font-semibold ring-1 ring-inset'
                        : 'hover:bg-muted text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <item.icon className="h-4 w-4" aria-hidden="true" />
                    {item.label}
                  </Link>
                );
              })}
            </TooltipProvider>
          </nav>

          <div className="space-y-2 border-t p-2">
            <Button
              variant="ghost"
              className={cn(
                'text-muted-foreground h-9 w-full justify-start px-3 text-xs',
                isCollapsed && 'justify-center px-0',
              )}
              aria-label={t(isCollapsed ? 'nav.expand-sidebar' : 'nav.collapse-sidebar')}
              aria-expanded={!isCollapsed}
              title={t(isCollapsed ? 'nav.expand-sidebar' : 'nav.collapse-sidebar')}
              onClick={() => setIsCollapsed(!isCollapsed)}
            >
              {isCollapsed ? (
                <ChevronRight aria-hidden="true" />
              ) : (
                <ChevronLeft aria-hidden="true" />
              )}
              {!isCollapsed && t('nav.collapse-sidebar')}
            </Button>
            <StatusBar isCollapsed={isCollapsed} />
          </div>
        </aside>

        {/* Content Area */}
        <main className="min-w-0 flex-1 overflow-auto">
          <ErrorBoundary
            resetKeys={[location.pathname]}
            onReset={() => {
              hasShownRouteErrorToastRef.current = false;
            }}
            onError={(error) => {
              if (hasShownRouteErrorToastRef.current) {
                return;
              }

              toast({
                error,
                title: t('error.generic'),
                description: getLocalizedErrorMessage(error, t),
                variant: 'destructive',
              });
              hasShownRouteErrorToastRef.current = true;
            }}
            fallbackRender={({ resetErrorBoundary }) => (
              <div className="mx-auto max-w-3xl p-6">
                <div className="rounded-lg border border-dashed p-8 text-center">
                  <div className="text-lg font-semibold">{t('error.generic')}</div>
                  <div className="text-muted-foreground mt-2 text-sm">{t('action.retry')}</div>
                  <Button className="mt-4" variant="outline" onClick={resetErrorBoundary}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {t('action.retry')}
                  </Button>
                </div>
              </div>
            )}
          >
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
};
