import React from "react";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { StatusBar } from "@/components/StatusBar";
import { LayoutDashboard, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";

export const MainLayout: React.FC = () => {
  const location = useLocation();
  const { t } = useTranslation();

  const navItems = [
    {
      to: "/",
      icon: LayoutDashboard,
      label: t("nav.accounts"),
    },
    {
      to: "/settings",
      icon: Settings,
      label: t("nav.settings"),
    },
  ];

  return (
    <div className="bg-background text-foreground flex h-screen flex-col overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="bg-muted/10 flex w-64 flex-col border-r">
          <div className="p-6">
            <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
              <div className="bg-primary h-6 w-6 rounded" />
              Antigravity
            </h1>
            <p className="text-muted-foreground mt-1 text-xs">Manager</p>
          </div>

          <nav className="flex-1 space-y-2 px-4">
            {navItems.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  location.pathname === item.to
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="border-t p-4">
            <StatusBar />
          </div>
        </aside>

        {/* Content Area */}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
