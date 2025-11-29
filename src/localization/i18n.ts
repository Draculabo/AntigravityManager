import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "en",
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "lang",
    },
    resources: {
      en: {
        translation: {
          appName: "Antigravity Manager",
          status: {
            checking: "Checking status...",
            running: "Antigravity is running in background",
            stopped: "Antigravity service stopped",
          },
          action: {
            stop: "Stop",
            start: "Start",
            switch: "Switch",
            deleteBackup: "Delete Backup",
            backupCurrent: "Backup Current",
          },
          nav: {
            accounts: "Accounts",
            settings: "Settings",
          },
          account: {
            current: "Current",
            lastUsed: "Last used {{time}}",
          },
          home: {
            title: "Accounts",
            description:
              "Manage your Antigravity account backups and switch between them.",
            noBackups: {
              title: "No backups found",
              description:
                "Create a backup of your current Antigravity account to get started.",
              action: "Backup Current Account",
            },
          },
          settings: {
            title: "Settings",
            description: "Manage application preferences.",
            appearance: {
              title: "Appearance",
              description:
                "Customize how Antigravity Manager looks on your device.",
            },
            darkMode: "Dark Mode",
            darkModeDescription:
              "Enable dark mode for better viewing at night.",
            language: {
              title: "Language",
              description: "Select your preferred language.",
              english: "English",
              chinese: "Chinese (Simplified)",
            },
            about: {
              title: "About",
              description: "Application information.",
            },
            version: "Version",
            platform: "Platform",
            license: "License",
          },
          toast: {
            backupSuccess: {
              title: "Success",
              description: "Account backup created successfully.",
            },
            backupError: {
              title: "Error",
              description: "Failed to create backup: {{error}}",
            },
            switchSuccess: {
              title: "Success",
              description: "Switched account successfully.",
            },
            switchError: {
              title: "Error",
              description: "Failed to switch account: {{error}}",
            },
            deleteSuccess: {
              title: "Success",
              description: "Account backup deleted successfully.",
            },
            deleteError: {
              title: "Error",
              description: "Failed to delete backup: {{error}}",
            },
          },
        },
      },
      "zh-CN": {
        translation: {
          appName: "Antigravity 管理器",
          status: {
            checking: "正在检查状态...",
            running: "Antigravity 正在后台运行",
            stopped: "Antigravity 服务已停止",
          },
          action: {
            stop: "停止",
            start: "启动",
            switch: "切换",
            deleteBackup: "删除备份",
            backupCurrent: "备份当前账号",
          },
          nav: {
            accounts: "账号",
            settings: "设置",
          },
          account: {
            current: "当前",
            lastUsed: "上次使用 {{time}}",
          },
          home: {
            title: "账号列表",
            description: "管理您的 Antigravity 账号备份并在它们之间切换。",
            noBackups: {
              title: "未找到备份",
              description: "备份您当前的 Antigravity 账号以开始使用。",
              action: "备份当前账号",
            },
          },
          settings: {
            title: "设置",
            description: "管理应用偏好设置。",
            appearance: {
              title: "外观",
              description: "自定义 Antigravity 管理器在您设备上的显示方式。",
            },
            darkMode: "深色模式",
            darkModeDescription: "启用深色模式以获得更好的夜间观看体验。",
            language: {
              title: "语言",
              description: "选择您的首选语言。",
              english: "英语",
              chinese: "中文 (简体)",
            },
            about: {
              title: "关于",
              description: "应用信息。",
            },
            version: "版本",
            platform: "平台",
            license: "许可证",
          },
          toast: {
            backupSuccess: {
              title: "成功",
              description: "账号备份创建成功。",
            },
            backupError: {
              title: "错误",
              description: "创建备份失败：{{error}}",
            },
            switchSuccess: {
              title: "成功",
              description: "切换账号成功。",
            },
            switchError: {
              title: "错误",
              description: "切换账号失败：{{error}}",
            },
            deleteSuccess: {
              title: "成功",
              description: "账号备份删除成功。",
            },
            deleteError: {
              title: "错误",
              description: "删除备份失败：{{error}}",
            },
          },
        },
      },
    },
  });
