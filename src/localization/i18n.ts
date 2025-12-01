import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'lang',
    },
    supportedLngs: ['en', 'zh-CN'],
    nonExplicitSupportedLngs: true,
    resources: {
      en: {
        translation: {
          appName: 'Antigravity Manager',
          status: {
            checking: 'Checking status...',
            running: 'Antigravity is running in background',
            stopped: 'Antigravity service stopped',
          },
          action: {
            stop: 'Stop',
            start: 'Start',
            switch: 'Switch',
            deleteBackup: 'Delete Backup',
            backupCurrent: 'Backup Current',
          },
          nav: {
            accounts: 'Accounts',
            settings: 'Settings',
          },
          account: {
            current: 'Current',
            lastUsed: 'Last used {{time}}',
          },
          home: {
            title: 'Accounts',
            description: 'Manage your Antigravity account backups and switch between them.',
            noBackups: {
              title: 'No backups found',
              description: 'Create a backup of your current Antigravity account to get started.',
              action: 'Backup Current Account',
            },
          },
          settings: {
            title: 'Settings',
            description: 'Manage application preferences.',
            appearance: {
              title: 'Appearance',
              description: 'Customize how Antigravity Manager looks on your device.',
            },
            darkMode: 'Dark Mode',
            darkModeDescription: 'Enable dark mode for better viewing at night.',
            language: {
              title: 'Language',
              description: 'Select your preferred language.',
              english: 'English',
              chinese: 'Chinese (Simplified)',
            },
            about: {
              title: 'About',
              description: 'Application information.',
            },
            version: 'Version',
            platform: 'Platform',
            license: 'License',
          },
          toast: {
            backupSuccess: {
              title: 'Success',
              description: 'Account backup created successfully.',
            },
            backupError: {
              title: 'Error',
              description: 'Failed to create backup: {{error}}',
            },
            switchSuccess: {
              title: 'Success',
              description: 'Switched account successfully.',
            },
            switchError: {
              title: 'Error',
              description: 'Failed to switch account: {{error}}',
            },
            deleteSuccess: {
              title: 'Success',
              description: 'Account backup deleted successfully.',
            },
            deleteError: {
              title: 'Error',
              description: 'Failed to delete backup: {{error}}',
            },
          },
          cloud: {
            title: 'Cloud Resources',
            description: 'Manage your Google Gemini / Claude account pool.',
            autoSwitch: 'Auto-Switch',
            addAccount: 'Add Account',
            syncFromIDE: 'Sync from IDE',
            checkQuota: 'Check Quota Now',
            polling: 'Polling triggered',
            authDialog: {
              title: 'Add Google Account',
              description: 'To add an account, you need to authorize the application.',
              openLogin: 'Open Login Page',
              authCode: 'Authorization Code',
              placeholder: 'Paste the code starting with 4/...',
              instruction: 'Copy the code from the redirected page (localhost) and paste it here.',
              verify: 'Verify & Add',
            },
            card: {
              active: 'Active',
              use: 'Use',
              rateLimited: 'Rate Limited',
              left: 'left',
              used: 'Used',
              unknown: 'Unknown User',
              actions: 'Actions',
              useAccount: 'Use Account',
              refresh: 'Refresh Quota',
              delete: 'Delete Account',
              noQuota: 'No quota data',
            },
            list: {
              noAccounts: 'No cloud accounts added yet.',
            },
            toast: {
              syncSuccess: {
                title: 'Sync Successful',
                description: 'Imported {{email}} from IDE.',
              },
              syncFailed: {
                title: 'Sync Failed',
                description: 'No active account found in IDE database.',
              },
              addSuccess: 'Account added successfully!',
              addFailed: {
                title: 'Failed to add account',
              },
              quotaRefreshed: 'Quota refreshed',
              refreshFailed: 'Failed to refresh quota',
              switched: {
                title: 'Account switched!',
                description: 'Restarting Antigravity...',
              },
              switchFailed: 'Failed to switch account',
              deleted: 'Account deleted',
              deleteFailed: 'Failed to delete account',
              deleteConfirm: 'Are you sure you want to delete this account?',
              autoSwitchOn: 'Auto-Switch Enabled',
              autoSwitchOff: 'Auto-Switch Disabled',
              updateSettingsFailed: 'Failed to update settings',
            },
            batch: {
              selected: 'Selected {{count}}',
              delete: 'Delete Selected',
              refresh: 'Refresh Selected',
              selectAll: 'Select All',
              clear: 'Clear Selection',
              confirmDelete: 'Are you sure you want to delete {{count}} accounts?',
            },
          },
        },
      },
      'zh-CN': {
        translation: {
          appName: 'Antigravity 管理器',
          status: {
            checking: '正在检查状态...',
            running: 'Antigravity 正在后台运行',
            stopped: 'Antigravity 服务已停止',
          },
          action: {
            stop: '停止',
            start: '启动',
            switch: '切换',
            deleteBackup: '删除备份',
            backupCurrent: '备份当前账号',
          },
          nav: {
            accounts: '账号',
            settings: '设置',
          },
          account: {
            current: '当前',
            lastUsed: '上次使用 {{time}}',
          },
          home: {
            title: '账号列表',
            description: '管理您的 Antigravity 账号备份并在它们之间切换。',
            noBackups: {
              title: '未找到备份',
              description: '备份您当前的 Antigravity 账号以开始使用。',
              action: '备份当前账号',
            },
          },
          settings: {
            title: '设置',
            description: '管理应用偏好设置。',
            appearance: {
              title: '外观',
              description: '自定义 Antigravity 管理器在您设备上的显示方式。',
            },
            darkMode: '深色模式',
            darkModeDescription: '启用深色模式以获得更好的夜间观看体验。',
            language: {
              title: '语言',
              description: '选择您的首选语言。',
              english: '英语',
              chinese: '中文 (简体)',
            },
            about: {
              title: '关于',
              description: '应用信息。',
            },
            version: '版本',
            platform: '平台',
            license: '许可证',
          },
          toast: {
            backupSuccess: {
              title: '成功',
              description: '账号备份创建成功。',
            },
            backupError: {
              title: '错误',
              description: '创建备份失败：{{error}}',
            },
            switchSuccess: {
              title: '成功',
              description: '切换账号成功。',
            },
            switchError: {
              title: '错误',
              description: '切换账号失败：{{error}}',
            },
            deleteSuccess: {
              title: '成功',
              description: '账号备份删除成功。',
            },
            deleteError: {
              title: '错误',
              description: '删除备份失败：{{error}}',
            },
          },
          cloud: {
            title: '云资源',
            description: '管理您的 Google Gemini / Claude 账号池。',
            autoSwitch: '自动切换',
            addAccount: '添加账号',
            syncFromIDE: '从 IDE 同步',
            checkQuota: '立即检查配额',
            polling: '已触发轮询',
            authDialog: {
              title: '添加 Google 账号',
              description: '添加账号需要进行应用授权。',
              openLogin: '打开登录页面',
              authCode: '授权码',
              placeholder: '粘贴以 4/ 开头的代码...',
              instruction: '复制重定向页面 (localhost) 中的代码并粘贴到此处。',
              verify: '验证并添加',
            },
            card: {
              active: '活跃',
              use: '使用',
              rateLimited: '受限',
              left: '剩余',
              used: '已用',
              unknown: '未知用户',
              actions: '操作',
              useAccount: '使用账号',
              refresh: '刷新配额',
              delete: '删除账号',
              noQuota: '无配额数据',
            },
            list: {
              noAccounts: '暂无云账号。',
            },
            toast: {
              syncSuccess: {
                title: '同步成功',
                description: '已从 IDE 导入 {{email}}。',
              },
              syncFailed: {
                title: '同步失败',
                description: 'IDE 数据库中未找到活跃账号。',
              },
              addSuccess: '账号添加成功！',
              addFailed: {
                title: '添加账号失败',
              },
              quotaRefreshed: '配额已刷新',
              refreshFailed: '刷新配额失败',
              switched: {
                title: '账号已切换！',
                description: '正在重启 Antigravity...',
              },
              switchFailed: '切换账号失败',
              deleted: '账号已删除',
              deleteFailed: '删除账号失败',
              deleteConfirm: '确定要删除此账号吗？',
              autoSwitchOn: '自动切换已启用',
              autoSwitchOff: '自动切换已禁用',
              updateSettingsFailed: '更新设置失败',
            },
            batch: {
              selected: '已选 {{count}} 项',
              delete: '删除选中',
              refresh: '刷新选中',
              selectAll: '全选',
              clear: '取消选择',
              confirmDelete: '确定要删除选中的 {{count}} 个账号吗？',
            },
          },
        },
      },
    },
  });
