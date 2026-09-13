import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'src-tauri', 'playwright-report', 'test-results', 'server'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Playwright E2E specs run in a browser context and lean on `any`
    // (page.evaluate returns unknown/any). Relax the strict rules there.
    files: ['e2e/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Standalone .mjs utility scripts (e.g. shot.mjs) use Playwright's
    // page.evaluate which references browser globals, plus Node's console.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
)
