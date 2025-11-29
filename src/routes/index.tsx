import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  listAccounts,
  addAccountSnapshot,
  switchAccount,
  deleteAccount,
} from "@/actions/account";
import { AccountCard } from "@/components/AccountCard";
import { Button } from "@/components/ui/button";
import { Plus, Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { getCurrentAccountInfo } from "@/actions/database";
import { useTranslation } from "react-i18next";

function HomePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const hasAutoBackedUp = useRef(false);

  // Fetch current account info from DB to identify active account
  const {
    data: currentInfo,
    isLoading: isLoadingCurrent,
    isError: isErrorCurrent,
    error: errorCurrent,
  } = useQuery({
    queryKey: ["currentAccount"],
    queryFn: getCurrentAccountInfo,
    refetchInterval: 10000, // Increase interval to reduce load
    retry: 1, // Reduce retries to avoid long loading states
  });

  const {
    data: accounts,
    isLoading: isLoadingAccounts,
    isError: isErrorAccounts,
    error: errorAccounts,
  } = useQuery({
    queryKey: ["accounts"],
    queryFn: listAccounts,
  });

  // Mutations
  const addMutation = useMutation({
    mutationFn: addAccountSnapshot,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast({
        title: t("toast.backupSuccess.title"),
        description: t("toast.backupSuccess.description"),
      });
    },
    onError: (error) => {
      toast({
        title: t("toast.backupError.title"),
        description: t("toast.backupError.description", {
          error: error.message,
        }),
        variant: "destructive",
      });
    },
  });

  const switchMutation = useMutation({
    mutationFn: switchAccount,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["currentAccount"] });
      queryClient.invalidateQueries({ queryKey: ["accounts"] }); // Last used time updates
      toast({
        title: t("toast.switchSuccess.title"),
        description: t("toast.switchSuccess.description"),
      });
    },
    onError: (error) => {
      toast({
        title: t("toast.switchError.title"),
        description: t("toast.switchError.description", {
          error: error.message,
        }),
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAccount,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast({
        title: t("toast.deleteSuccess.title"),
        description: t("toast.deleteSuccess.description"),
      });
    },
    onError: (error) => {
      toast({
        title: t("toast.deleteError.title"),
        description: t("toast.deleteError.description", {
          error: error.message,
        }),
        variant: "destructive",
      });
    },
  });

  // Auto-backup on initial load (matching Python implementation)
  useEffect(() => {
    if (!hasAutoBackedUp.current && currentInfo?.isAuthenticated) {
      hasAutoBackedUp.current = true;
      // Delay slightly to ensure UI is loaded
      const timer = setTimeout(() => {
        addMutation.mutate();
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [currentInfo?.isAuthenticated]);

  if (isLoadingAccounts || isLoadingCurrent) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (isErrorAccounts || isErrorCurrent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="text-destructive text-lg font-semibold">
          {t("error.generic")}
        </div>
        <p className="text-muted-foreground text-sm">
          {errorAccounts?.message || errorCurrent?.message}
        </p>
        <Button onClick={() => queryClient.invalidateQueries()}>
          {t("action.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-4xl p-6">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">
            {t("home.title")}
          </h2>
          <p className="text-muted-foreground mt-1">{t("home.description")}</p>
        </div>
        <Button
          onClick={() => addMutation.mutate()}
          disabled={addMutation.isPending}
        >
          {addMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          {t("action.backupCurrent")}
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {accounts?.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            isCurrent={currentInfo?.email === account.email}
            onSwitch={(id) => switchMutation.mutate(id)}
            onDelete={(id) => deleteMutation.mutate(id)}
            isSwitching={
              switchMutation.isPending &&
              switchMutation.variables === account.id
            }
            isDeleting={
              deleteMutation.isPending &&
              deleteMutation.variables === account.id
            }
          />
        ))}

        {accounts?.length === 0 && (
          <div className="bg-muted/10 col-span-full rounded-lg border-2 border-dashed py-12 text-center">
            <h3 className="text-lg font-medium">{t("home.noBackups.title")}</h3>
            <p className="text-muted-foreground mt-1 mb-4">
              {t("home.noBackups.description")}
            </p>
            <Button
              variant="secondary"
              onClick={() => addMutation.mutate()}
              disabled={addMutation.isPending}
            >
              {t("home.noBackups.action")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/")({
  component: HomePage,
});
