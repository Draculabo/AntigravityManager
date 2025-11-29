import { createFileRoute } from "@tanstack/react-router";
import { useTheme } from "@/components/theme-provider";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";
import { getAppVersion, getPlatform } from "@/actions/app";
import { useTranslation } from "react-i18next";
import { setAppLanguage } from "@/actions/language";

function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { t, i18n } = useTranslation();

  const { data: appVersion } = useQuery({
    queryKey: ["app", "version"],
    queryFn: getAppVersion,
  });

  const { data: platform } = useQuery({
    queryKey: ["app", "platform"],
    queryFn: getPlatform,
  });

  const handleLanguageChange = (value: string) => {
    setAppLanguage(value, i18n);
  };

  return (
    <div className="container mx-auto max-w-2xl space-y-8 p-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">
          {t("settings.title")}
        </h2>
        <p className="text-muted-foreground mt-1">
          {t("settings.description")}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.appearance.title")}</CardTitle>
          <CardDescription>
            {t("settings.appearance.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between space-x-2">
            <div className="space-y-1">
              <Label htmlFor="dark-mode">{t("settings.darkMode")}</Label>
              <p className="text-muted-foreground text-sm">
                {t("settings.darkModeDescription")}
              </p>
            </div>
            <Switch
              id="dark-mode"
              checked={theme === "dark"}
              onCheckedChange={(checked) =>
                setTheme(checked ? "dark" : "light")
              }
            />
          </div>

          <div className="flex items-center justify-between space-x-2">
            <div className="space-y-1">
              <Label htmlFor="language">{t("settings.language.title")}</Label>
              <p className="text-muted-foreground text-sm">
                {t("settings.language.description")}
              </p>
            </div>
            <Select value={i18n.language} onValueChange={handleLanguageChange}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder={t("settings.language.title")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">
                  {t("settings.language.english")}
                </SelectItem>
                <SelectItem value="zh-CN">
                  {t("settings.language.chinese")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.about.title")}</CardTitle>
          <CardDescription>{t("settings.about.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="text-muted-foreground">{t("settings.version")}</div>
            <div className="font-medium">{appVersion || "Unknown"}</div>

            <div className="text-muted-foreground">
              {t("settings.platform")}
            </div>
            <div className="font-medium capitalize">
              {platform || "Unknown"}
            </div>

            <div className="text-muted-foreground">{t("settings.license")}</div>
            <div className="font-medium">MIT</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});
