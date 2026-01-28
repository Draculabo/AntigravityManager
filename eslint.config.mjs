import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginReact from 'eslint-plugin-react';
import eslintPluginPrettierRecommended from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import path from 'node:path';
import { includeIgnoreFile } from '@eslint/compat';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'eslint/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const prettierIgnorePath = path.resolve(__dirname, '.prettierignore');

/** @type {import('eslint').Linter.Config[]} */
export default defineConfig([
  includeIgnoreFile(prettierIgnorePath),
  {
    files: ['**/*.{js,mjs,cjs,ts,jsx,tsx}'],
  },
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  pluginJs.configs.recommended,
  pluginReact.configs.flat['jsx-runtime'],
  reactHooks.configs.flat.recommended,
  eslintPluginPrettierRecommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-empty-pattern': 'off',
      'prefer-const': 'off',
    },
  },
]);
