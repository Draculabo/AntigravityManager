import React, { useState, useEffect } from 'react';
import { Link, Outlet, useLocation } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { StatusBar } from '@/components/StatusBar';
import {
  LayoutDashboard,
  Settings,
  Network,
  Rocket,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export const MainLayout: React.FC = () => {
  const location = useLocation();
  const { t } = useTranslation();

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
      label: t('nav.proxy', 'API Proxy'),
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
            'bg-muted/10 group relative flex flex-col border-r transition-all duration-300 ease-in-out',
            isCollapsed ? 'w-[70px]' : 'w-64',
          )}
        >
          {/* Toggle Button - Visible on hover or always if preferred. 
              Positioned absolute on the border line */}
          <Button
            variant="ghost"
            size="icon"
            className="bg-background hover:bg-accent hover:text-accent-foreground absolute top-6 -right-3 z-10 h-6 w-6 rounded-full border opacity-0 shadow-md transition-opacity group-hover:opacity-100"
            onClick={() => setIsCollapsed(!isCollapsed)}
          >
            {isCollapsed ? (
              <ChevronRight className="h-3 w-3" />
            ) : (
              <ChevronLeft className="h-3 w-3" />
            )}
          </Button>

          <div className={cn('flex flex-col', isCollapsed ? 'items-center p-4' : 'p-6')}>
            <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap">
              <div className="bg-primary text-primary-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded">
                <Rocket className="h-4 w-4" />
              </div>
              <div
                className={cn(
                  'overflow-hidden transition-all duration-300',
                  isCollapsed ? 'w-0 opacity-0' : 'w-auto opacity-100',
                )}
              >
                <h1 className="text-xl font-bold tracking-tight">Antigravity</h1>
              </div>
            </div>
            <div
              className={cn(
                'text-muted-foreground mt-1 overflow-hidden text-xs whitespace-nowrap transition-all duration-300',
                isCollapsed ? 'h-0 opacity-0' : 'h-auto opacity-100',
              )}
            >
              Manager
            </div>
          </div>

          <nav className="flex-1 space-y-2 px-2">
            <TooltipProvider>
              {navItems.map((item) => {
                const isActive = location.pathname === item.to;

                if (isCollapsed) {
                  return (
                    <Tooltip key={item.to} delayDuration={0}>
                      <TooltipTrigger asChild>
                        <Link
                          to={item.to}
                          className={cn(
                            'mx-auto flex h-10 w-10 items-center justify-center rounded-md transition-colors',
                            isActive
                              ? 'bg-primary text-primary-foreground'
                              : 'hover:bg-muted text-muted-foreground hover:text-foreground',
                          )}
                        >
                          <item.icon className="h-5 w-5" />
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
                    className={cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-muted text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </TooltipProvider>
          </nav>

          <div className="border-t p-2">
            <StatusBar isCollapsed={isCollapsed} />
          </div>
        </aside>

        {/* Content Area */}
        <main className="flex-1 overflow-auto transition-all duration-300">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
