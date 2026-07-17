// ESLint v9 flat config.
// Targets src/**/*.ts with @typescript-eslint recommended rules.
// Matches the strict TSC posture in tsconfig.json: warns on unused vars,
// allows underscore-prefixed args, tolerates `any` (legitimate for SQLite row types).

import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '**/*.js', '**/*.mjs', '**/*.cjs'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      // Core ESLint rules that don't understand TypeScript. Per typescript-eslint's
      // documented guidance, tsc already reports these far more accurately, and the
      // core rules produce false positives on TS-only constructs:
      //   no-undef     — type-only globals (`NodeJS.ProcessEnv`) look undefined
      //   no-redeclare — enum + namespace declaration merging (states.ts MESIState)
      'no-undef': 'off',
      'no-redeclare': 'off',
    },
  },
];
