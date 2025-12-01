import React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  isProcessRunning,
  startAntigravity,
  closeAntigravity,
} from "@/actions/process";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Play, Square, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export const StatusBar: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: isRunning, isLoading } = useQuery({
    queryKey: ["process", "status"],
    queryFn: isProcessRunning,
    refetchInterval: 2000,
  });

  const startMutation = useMutation({
    mutationFn: startAntigravity,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["process", "status"] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: closeAntigravity,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["process", "status"] });
    },
  });

  const handleToggle = () => {
    if (isRunning) {
      stopMutation.mutate();
    } else {
      startMutation.mutate();
    }
  };

  const isPending = startMutation.isPending || stopMutation.isPending;

  return (
    <div
      className={cn(
        "flex items-center justify-between px-4 py-2 text-sm font-medium transition-colors",
        isRunning
          ? "bg-green-100 text-green-900 dark:bg-green-900/30 dark:text-green-100"
          : "bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-100",
      )}
    >
      <div className="flex items-center gap-2">
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : isRunning ? (
          <div className="h-3 w-3 rounded-full bg-green-500" />
        ) : (
          <div className="h-3 w-3 rounded-full bg-red-500" />
        )}
        <span>
          {isLoading
            ? t("status.checking")
            : isRunning
              ? t("status.running")
              : t("status.stopped")}
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleToggle}
        disabled={isLoading || isPending}
        className={cn(
          "h-8 px-3 hover:bg-white/20",
          isRunning ? "hover:text-green-900" : "hover:text-red-900",
        )}
      >
        {isPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : isRunning ? (
          <Square className="mr-2 h-4 w-4 fill-current" />
        ) : (
          <Play className="mr-2 h-4 w-4 fill-current" />
        )}
        {isRunning ? t("action.stop") : t("action.start")}
      </Button>
    </div>
  );
};
