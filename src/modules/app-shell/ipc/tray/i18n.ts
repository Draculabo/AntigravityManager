import { normalizeDesktopLanguage, type DesktopLanguage } from '../../desktop-appearance';

export type TrayTexts = {
  current: string;
  quota: string;
  switch_next: string;
  refresh_current: string;
  show_window: string;
  quit: string;
  no_account: string;
  unknown_quota: string;
  forbidden: string;
};

const en: TrayTexts = {
  current: 'Current Classic Account',
  quota: 'Quota',
  switch_next: 'Switch to Next Account',
  refresh_current: 'Refresh Current Quota',
  show_window: 'Show Main Window',
  quit: 'Quit Application',
  no_account: 'No Account',
  unknown_quota: 'Unknown',
  forbidden: 'Account Forbidden',
};

const zh: TrayTexts = {
  current: '当前 Classic 账号',
  quota: '当前额度',
  switch_next: '切换到下一个账号',
  refresh_current: '刷新当前额度',
  show_window: '显示主窗口',
  quit: '退出应用',
  no_account: '无账号',
  unknown_quota: '未知',
  forbidden: '账号已被禁用',
};

const ru: TrayTexts = {
  current: 'Текущий аккаунт Classic',
  quota: 'Квота',
  switch_next: 'Переключить на следующий аккаунт',
  refresh_current: 'Обновить текущую квоту',
  show_window: 'Показать главное окно',
  quit: 'Выйти из приложения',
  no_account: 'Нет аккаунта',
  unknown_quota: 'Неизвестно',
  forbidden: 'Аккаунт заблокирован',
};

const vi: TrayTexts = {
  current: 'Tài khoản Classic hiện tại',
  quota: 'Quota',
  switch_next: 'Chuyển sang tài khoản tiếp theo',
  refresh_current: 'Làm mới quota hiện tại',
  show_window: 'Hiện cửa sổ chính',
  quit: 'Thoát ứng dụng',
  no_account: 'Không có tài khoản',
  unknown_quota: 'Không rõ',
  forbidden: 'Tài khoản bị cấm',
};

const fr: TrayTexts = {
  current: 'Compte Classic actuel',
  quota: 'Quota',
  switch_next: 'Basculer vers le compte suivant',
  refresh_current: 'Actualiser le quota actuel',
  show_window: 'Afficher la fenetre principale',
  quit: 'Quitter l application',
  no_account: 'Aucun compte',
  unknown_quota: 'Inconnu',
  forbidden: 'Compte bloque',
};

const ptBR: TrayTexts = {
  current: 'Conta Classic atual',
  quota: 'Cota',
  switch_next: 'Alternar para o Próximo',
  refresh_current: 'Atualizar Cota Atual',
  show_window: 'Mostrar Janela Principal',
  quit: 'Sair do Aplicativo',
  no_account: 'Nenhuma Conta',
  unknown_quota: 'Desconhecida',
  forbidden: 'Conta Proibida',
};

const tr: TrayTexts = {
  current: 'Mevcut Classic Hesabı',
  quota: 'Kota',
  switch_next: 'Sonraki Hesaba Geç',
  refresh_current: 'Mevcut Kotayı Yenile',
  show_window: 'Ana Pencereyi Göster',
  quit: 'Uygulamadan Çık',
  no_account: 'Hesap Yok',
  unknown_quota: 'Bilinmiyor',
  forbidden: 'Hesap Yasaklandı',
};

const ja: TrayTexts = {
  current: '現在の Classic アカウント',
  quota: '残りの利用枠',
  switch_next: '次のアカウントに切り替え',
  refresh_current: '現在の利用枠を更新',
  show_window: 'メインウィンドウを表示',
  quit: 'アプリを終了',
  no_account: 'アカウントなし',
  unknown_quota: '不明',
  forbidden: 'アカウントは利用できません',
};

const trayTexts: Record<DesktopLanguage, TrayTexts> = {
  en,
  'zh-CN': zh,
  ru,
  vi,
  fr,
  'pt-BR': ptBR,
  tr,
  ja,
};

export function getTrayTexts(lang = 'en'): TrayTexts {
  return trayTexts[normalizeDesktopLanguage(lang)];
}
