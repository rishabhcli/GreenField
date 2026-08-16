/**
 * ESLint flat configuration.
 *
 * WHY THIS FILE IS COMMONJS
 *
 * The root `package.json` has no `"type": "module"`, and it must not gain one:
 * `apps/site` has no `package.json` of its own, so `apps/site/serve.js` — which
 * is genuine CommonJS (`require`, `__dirname`) — inherits the root's module
 * type. Flipping the root to ESM to satisfy this config would break that file.
 * ESLint 9 loads a CommonJS flat config natively, so the cheap fix is to write
 * one and leave the rest of the repo alone.
 *
 * WHY THE RULE SET IS DELIBERATELY NARROW
 *
 * `tsc -b tsconfig.build.json` is already the correctness gate for this repo,
 * and CI runs it before this. Anything ESLint could tell us about types it
 * would be telling us a second time, more slowly, from a second program build.
 * So this takes the *non* type-checked `typescript-eslint` preset on purpose:
 *
 *   - `recommendedTypeChecked` needs its own TypeScript program. Across twelve
 *     composite projects that means either `projectService` (which holds the
 *     whole graph in memory) or enumerating every tsconfig, for findings the
 *     compiler already produces on the previous CI step.
 *   - The type-aware rules that would genuinely add something the compiler
 *     cannot see — `no-floating-promises` above all, in a system where a
 *     dropped promise loses money state — are worth having, but they have to
 *     arrive together with the source fixes they demand. Switching them on
 *     here, against a codebase that has never been linted, would mean either
 *     mass suppression comments or a lint step that is red on arrival. A lint
 *     step that is always red is one people learn to skip, which is worse than
 *     not having one at all.
 *
 * So the contract of `pnpm lint` is: syntax hygiene, dead code, accidental
 * `console`, and the TypeScript footguns that need no type information. The
 * compiler owns everything else.
 *
 * WHY EACH RELAXATION EXISTS
 *
 * Every deviation from the presets below carries its reason inline. A
 * relaxation with no reason is a rule nobody actually chose, and six months
 * later nobody can tell it apart from one that was simply in the way.
 */

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

/** Source and test TypeScript across every workspace package. */
const WORKSPACE_TS = [
  'packages/*/src/**/*.ts',
  'apps/*/src/**/*.ts',
  'packages/*/test/**/*.ts',
  'apps/*/test/**/*.ts',
];

module.exports = tseslint.config(
  {
    // Not linted, in order: build output and its incremental state, installed
    // dependencies, coverage reports, and the shipped bytes of `apps/site`.
    //
    // `apps/site` is a static landing page with no `package.json` and no
    // `tsconfig.json`; it is deliberately outside the pnpm workspace and
    // outside `tsc -b`, so it is outside this too. Its *test* directory is a
    // real vitest suite that runs under `pnpm test`, and that IS linted.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      '**/coverage/**',
      'apps/site/assets/**',
      'apps/site/*.js',
      // Ephemeral driver/inspection scripts run against live infra by hand.
      // They are gitignored and never built, so linting them only produces
      // no-undef noise for Node globals the TS config does not declare.
      '**/*.tmp.mjs',
      '**/_*.mjs',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: WORKSPACE_TS,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // Warn, not error. `noUnusedLocals` is off in tsconfig.base.json, so this
      // is the only report of dead symbols anywhere in the toolchain — and the
      // handful that exist today are dead imports in files that this change is
      // not permitted to touch. Erroring would make `pnpm lint` red on arrival
      // and teach everyone to pass `--no-verify`. Warning keeps the true state
      // visible without fabricating a green build.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          // Parameters are not checked at all: handler signatures here are
          // fixed by their framework, not by the handler. The tool registry
          // calls every `execute(input, ctx)` with both arguments whether or
          // not a given tool reads `ctx`, and Fastify does the same for hooks.
          // An unused trailing parameter in that position is a contract, not
          // dead code, and flagging it is pure noise.
          args: 'none',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      // `isProduction ? blockers.push(entry) : warnings.push(entry)` is the
      // shape `evaluateReleaseGate` uses to route a finding to one of two
      // sinks. It is an expression statement on purpose; `allowTernary` is the
      // option the rule ships for exactly this idiom.
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true }],

      // `export interface Services extends CompanyToolHost {}` is the
      // composition root naming the surface it satisfies. An empty interface
      // that extends exactly one supertype is a deliberate alias, not the
      // accidental `{}` type the rule is aimed at.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],

      // Logging goes through pino, configured centrally in `@foundry/obs`, so
      // that every line carries the request's traceId from the AsyncLocalStorage
      // context. A bare `console.log` in a service silently escapes all of that.
      //
      // `error` and `warn` stay allowed because they are the two cases where
      // the logger legitimately cannot be used: the top-level `main().catch()`
      // in each entrypoint, which runs when `buildContext` itself failed and
      // there is no logger yet, and the loud "skipping, no PostgreSQL"
      // notices that keep opt-in integration tests from passing silently.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  {
    // The provider adapter layer deliberately exports reassignable `let`
    // bindings for endpoints whose exact path research could not pin down —
    // Terac's `feasibilityRequestPath`, Solari's `profileCreatePath`, six in
    // Sandbox0 — each with a block comment saying so, so that correcting a path
    // after a live probe is a one-line change rather than a refactor.
    //
    // `prefer-const` cannot see that intent, and it is auto-fixable: running
    // `eslint --fix` would quietly overwrite a documented decision. Off is
    // safer here than a warning nobody can act on.
    files: ['packages/providers/src/**/*.ts'],
    rules: {
      'prefer-const': 'off',
    },
  },

  {
    // Plain-JS build scripts, e.g. `packages/db/scripts/copy-sql.mjs`, and this
    // file itself. No TypeScript program covers any of them, so `no-undef` is
    // the only thing that will catch a typo'd global — it needs to know it is
    // running on Node.
    //
    // `eslint.config.js` is included because it is CommonJS on purpose (see the
    // header) and is otherwise linted as if it were ESM — `require`, `module`
    // and `exports` are not globals in a module parser, so the first run would
    // report its own loading mechanism as an error. `no-require-imports` is off
    // for the same reason: this file must load its two plugins with `require`
    // because the root `package.json` must not become ESM.
    //
    // `globals` is not a direct dependency of this repo and adding one would
    // mean touching the lockfile that CI installs with `--frozen-lockfile`, so
    // the handful actually used are declared here.
    files: ['**/*.mjs', '**/*.cjs', 'eslint.config.js'],
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
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
