/**
 * Prettier 配置
 *
 */
module.exports = {
  endOfLine: 'lf',
  semi: true,
  singleQuote: true,
  printWidth: 100,
  tabWidth: 2,
  trailingComma: 'all',
  proseWrap: 'preserve',
  tailwindFunctions: ['clsx', 'tw'],
  plugins: ['prettier-plugin-tailwindcss'],
};
