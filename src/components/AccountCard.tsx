import React from "react";
import { Account } from "@/types/account";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreVertical, Trash2, RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface AccountCardProps {
  account: Account;
  isCurrent: boolean;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  isSwitching?: boolean;
  isDeleting?: boolean;
}

export const AccountCard: React.FC<AccountCardProps> = ({
  account,
  isCurrent,
  onSwitch,
  onDelete,
  isSwitching,
  isDeleting,
}) => {
  const { t } = useTranslation();
  const initials = account.name
    ? account.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : account.email[0].toUpperCase();

  return (
    <Card
      className={cn(
        "transition-all duration-200 hover:shadow-md",
        isCurrent
          ? "border-primary/50 bg-primary/5"
          : "hover:border-primary/20",
      )}
    >
      <CardContent className="flex items-center justify-between p-4">
        <div className="flex items-center gap-4">
          <Avatar
            className={cn(
              "h-10 w-10",
              isCurrent && "ring-primary ring-2 ring-offset-2",
            )}
          >
            <AvatarImage src={account.avatar_url} />
            <AvatarFallback
              className={isCurrent ? "bg-primary text-primary-foreground" : ""}
            >
              {initials}
            </AvatarFallback>
          </Avatar>

          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h4 className="leading-none font-semibold">{account.name}</h4>
              {isCurrent && (
                <Badge variant="default" className="h-5 px-1.5 text-[10px]">
                  {t("account.current")}
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground text-sm">{account.email}</p>
            <p className="text-muted-foreground/60 text-xs">
              {t("account.lastUsed", {
                time: formatDistanceToNow(new Date(account.last_used), {
                  addSuffix: true,
                }),
              })}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isCurrent && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onSwitch(account.id)}
              disabled={isSwitching || isDeleting}
            >
              {isSwitching ? (
                <RefreshCw className="mr-2 h-3 w-3 animate-spin" />
              ) : null}
              {t("action.switch")}
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreVertical className="h-4 w-4" />
                <span className="sr-only">Open menu</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => onDelete(account.id)}
                disabled={isDeleting}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t("action.deleteBackup")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  );
};
