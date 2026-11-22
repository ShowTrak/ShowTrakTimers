// ESLint configuration. ESLint loads this TypeScript file itself (through jiti,
// a devDependency for that reason); tsconfig.tooling.json type-checks it.
import js from '@eslint/js';
import globals from 'globals';
import markdown from '@eslint/markdown';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    ignores: [
      'src/UI/vendors/**',
      // The ShowTrak-Protocol submodule is linted in its own repository.
      'shared/**',
      'coverage/**',
      'node_modules/**',
      'out/**',
      'dist/**',
      'dist-test/**',
      '.vscode/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [
      js.configs.recommended, // Correct way to extend @eslint/js recommended config
      prettier,
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Correct way to configure options for the 'no-unused-vars' rule
      'no-unused-vars': [
        'error', // Or "warn", depending on your preference
        {
          caughtErrors: 'none',
          argsIgnorePattern: '^_[^_].*$|^_$',
          varsIgnorePattern: '^_[^_].*$|^_$',
          caughtErrorsIgnorePattern: '^_[^_].*$|^_$',
        },
      ],
    },
  },
  {
    // The JavaScript left in the repository: the tests and the build scripts.
    // (The app's own source, src/, is all TypeScript.)
    files: ['test/**/*.js', 'test-support/**/*.js', 'scripts/**/*.js'],
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },
  {
    // TypeScript: the app's source (main process, modules, bridges, renderer,
    // splash window, service worker) and the Forge and ESLint configs.
    files: ['**/*.ts'],
    // The submodule (ignored above) belongs to none of the projects below, so
    // it stays out of this block too.
    ignores: ['shared/**'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        // Linted with type information: every TypeScript file here belongs to
        // one of these programs (see `npm run typecheck`).
        project: [
          './tsconfig.json',
          './tsconfig.renderer.json',
          './tsconfig.preloader.json',
          './tsconfig.service-worker.json',
          './tsconfig.tooling.json',
        ],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      // No explicit `any`: if you truly need a dynamic value, use `unknown` and
      // narrow it.
      '@typescript-eslint/no-explicit-any': 'error',
      // No implicit `any` either. Whatever arrives as `any` (an untyped
      // require(), JSON.parse, an Electron or jQuery callback argument) is typed,
      // as `unknown` or by the contract in @showtrak/protocol/timers, and
      // narrowed (see src/common/guards.ts) before it is used.
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/no-unsafe-declaration-merging': 'error',
      '@typescript-eslint/no-unsafe-enum-comparison': 'error',
      '@typescript-eslint/no-unsafe-unary-minus': 'error',
      // Electron and a few CommonJS-only packages are loaded with require().
      '@typescript-eslint/no-require-imports': 'off',
      // jQuery handler patterns legitimately alias `this` (e.g. into rAF closures).
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          caughtErrors: 'none',
          argsIgnorePattern: '^_[^_].*$|^_$',
          varsIgnorePattern: '^_[^_].*$|^_$',
        },
      ],
    },
  },
  {
    files: ['**/*.md'],
    extends: [markdown.configs.recommended],
  },
  {
    // eslint 10 added `no-useless-assignment` to js.configs.recommended. The
    // codebase deliberately uses declare-with-default then assign-in-all-branches
    // (e.g. `let x = null; try { x = ... } catch { x = ... }`) for readability and
    // safe fallbacks, so the "dead" initializer is intentional. Keep it off to
    // preserve that style; revisit if we ever want to enforce it and fix the sites.
    files: ['**/*.{js,mjs,cjs,ts}'],
    rules: {
      'no-useless-assignment': 'off',
    },
  },
]);
