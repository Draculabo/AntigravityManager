# 设计：多语言支持

## 架构

应用使用 `react-i18next` 进行国际化，并配合 `i18next-browser-languagedetector` 进行语言检测。配置集中在 `src/localization/i18n.ts` 中。

### 语言资源

翻译资源将作为 JSON 对象构建在 `i18n.ts` 中（如果太大则分文件）。
我们将在 `resources` 对象中添加 `zh-CN` 键。

### 默认语言策略

我们将引入 `LanguageDetector` 插件。
`i18n.use(LanguageDetector).init({...})` 将被配置为首先检查 `localStorage`，然后检查 `navigator`（浏览器/系统语言）。
`fallbackLng` 将保持为 `'en'`，作为最后的兜底。

### 键映射

我们将把现有的英文字符串映射到语义键（例如 `home.title`, `settings.theme`）。

## 数据流

1. 应用启动。
2. `i18next` 初始化，通过 `LanguageDetector` 确定语言：
   * 检查 `localStorage` 是否有保存的偏好。
   * 如果无，检查 `navigator.language`。
   * 如果检测到的语言受支持（`en` 或 `zh-CN`），则使用该语言。
   * 否则，使用 `fallbackLng` (`en`)。
3. 组件使用 `useTranslation` hook 根据当前语言获取字符串。
