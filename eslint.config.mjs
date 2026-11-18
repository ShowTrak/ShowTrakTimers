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
      'forge.config.mjs',
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
    files: ['src/UI/js/app/**/*.js'],
    rules: {
      // Classic renderer scripts share globals across many files.
      // Keep lint coverage enabled while avoiding false positives.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-useless-escape': 'off',
    },
  },
  {
    // Non-renderer source (main process, modules, bridges, tests, scripts).
    // Renderer files intentionally keep var/globals, so these rules are scoped
    // away from src/UI/js/app.
    files: [
      'src/Modules/**/*.js',
      'src/main.js',
      'src/main/**/*.js',
      'src/bridge_main.js',
      'src/bridge_preloader.js',
      'test/**/*.js',
      'test-support/**/*.js',
      'scripts/**/*.js',
    ],
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },
  {
    // TypeScript source (main process, modules, renderer, shared types).
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      // No explicit `any`: if you truly need a dynamic value, use `unknown` and
      // narrow it.
      '@typescript-eslint/no-explicit-any': 'error',
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
