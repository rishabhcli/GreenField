// @ts-check
/**
 * ESLint flat configuration.
 *
 * WHY THIS IS DELIBERATELY NARROW
 *
 * `tsc -b tsconfig.build.json` is already the correctness gate for this repo,
 * and it runs first in CI. Anything ESLint could tell us about types, it would
 * be telling us a second time, more slowly, from a second program build. So
 * this config takes the *non* type-checked `typescript-eslint` preset on
 * purpose:
 *
 *   - `tseslint.configs.recommendedTypeChecked` needs its own TypeScript
 *     program. In a composite-project workspace that means either
 *     `projectService` (which holds the whole graph in memory) or enumerating
 *     twelve tsconfigs, and it roughly triples lint wall time for findings the
 *     compiler already produces.
 *   - The rules that would genuinely add something the compiler cannot see —
 *     `no-floating-promises` above all, in a system where a dropped promise
 *     loses money state — are worth revisiting, but they must be introduced
 *     with the source fixes in the same change. Turning them on here, on a
 *     codebase that has never been linted, would mean either mass suppression
 *     comments or a lint step that is red by default. A lint step that is
 *     always red teaches people to ignore it, which is worse than not having
 *     one.
 *
 * So the contract of `pnpm lint` is: syntax hygiene, dead code, and the small
 * set of TypeScript-specific footguns that do not need type information. The
 * compiler owns everything else.
 *
 * Every rule relaxation below carries a one-line reason. A relaxation without
 * a reason is a rule nobody chose.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Not linted, in order: build output, dependencies, and `apps/site`, which
    // is a static landing page with no package.json and no tsconfig — it is
    // deliberately outside the workspace and outside `tsc -b`, so it is outside
    // this too. (`apps/site/test` IS a real vitest suite and is linted below.)
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      '**/coverage/**',
      'apps/site/assets/**',
      'apps/site/*.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts', 'packages/*/test/**/*.ts', 'apps/*/test/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // An unused parameter named `_` is how this codebase writes "the position
      // matters, the value does not" — e.g. `new Promise<never>((_, reject) =>`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },

  {
    // Plain-JS build scripts (e.g. packages/db/scripts/copy-sql.mjs). No
    // TypeScript program covers these, so `no-undef` is the only thing telling
    // us about a typo'd global — it needs to know it is running on Node.
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
);
