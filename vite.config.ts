// Copyright (c) 2026 The Billy Company
import { fileURLToPath } from 'node:url'
import { defineConfig, lazyPlugins } from 'vite-plus'
import { safetyLint } from './app/tooling/quality/oxlint-safety.ts'
import { typeAwareLint } from './app/tooling/quality/oxlint-typeaware.ts'
export default defineConfig({
  staged: {
    '*': 'vp check --fix --no-error-on-unmatched-pattern',
  },
  fmt: {
    printWidth: 120,
    tabWidth: 2,
    useTabs: false,
    singleQuote: true,
    semi: false,
    trailingComma: 'all',
    arrowParens: 'avoid',
    endOfLine: 'lf',
    sortImports: {
      newlinesBetween: false,
      partitionByNewline: true,
      groups: ['builtin', 'external', ['internal', 'subpath'], ['parent', 'sibling', 'index'], 'unknown'],
    },
    ignorePatterns: ['app/tooling/grammars/snapshots/**/*.json'],
  },
  lint: {
    extends: [safetyLint, typeAwareLint],
    plugins: ['eslint', 'typescript', 'unicorn', 'oxc', 'import', 'promise', 'node'],
    categories: { correctness: 'error', suspicious: 'error', perf: 'error' },
    env: { node: true },
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      'eslint/no-undef': 'error',
      'eslint/no-unused-expressions': ['error', { allowTernary: true }],
      'eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'eslint/no-console': ['error', { allow: ['info', 'warn', 'error'] }],
      'eslint/prefer-template': 'error',
      'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
      'import/no-unassigned-import': ['error', { allow: ['**/*.css', '@parcel/watcher', 'monaco-editor/**/*.js'] }],
      'typescript/no-explicit-any': 'error',
      'typescript/no-non-null-assertion': 'error',
      'typescript/consistent-type-definitions': ['error', 'interface'],
    },
    overrides: [
      { files: ['app/renderer/**/*.{ts,js}', 'app/shared/preferences/shortcuts.ts'], env: { browser: true } },
      {
        files: [
          'app/tests/interface/desktop/workspace-fixture.ts',
          'app/tests/interface/assistant/agent-threads.integration.ts',
        ],
        env: { browser: true },
      },
      // Node Worker and MessagePort are point-to-point and have no target origin argument.
      {
        files: [
          'app/backend/runtime/window/main.mjs',
          'app/backend/runtime/session/session.mjs',
          'app/backend/workspace/comparison/diff-worker.ts',
        ],
        rules: { 'unicorn/require-post-message-target-origin': 'off' },
      },
      {
        files: ['app/tests/**/*.test.{ts,mjs}'],
        plugins: ['vitest'],
        rules: {
          'vitest/no-focused-tests': 'error',
          'vitest/no-standalone-expect': [
            'error',
            { additionalTestBlockFunctions: ['beforeAll', 'beforeEach', 'afterAll', 'afterEach'] },
          ],
          'vitest/valid-expect': ['error', { maxArgs: 2 }],
          'vitest/valid-expect-in-promise': 'error',
        },
      },
    ],
    options: { denyWarnings: true, reportUnusedDisableDirectives: 'error', typeAware: true, typeCheck: true },
  },
  plugins: lazyPlugins(async () => {
    const { syntaxCatalog } = await import('./app/tooling/grammars/catalog/syntax-catalog.ts')
    return [syntaxCatalog()]
  }),
  root: 'app',
  publicDir: '../branding/public',
  base: './',
  css: { transformer: 'lightningcss', lightningcss: { targets: { safari: 16 << 16 } } },
  build: {
    rolldownOptions: {
      input: {
        workspace: fileURLToPath(new URL('./app/index.html', import.meta.url)),
        terminal: fileURLToPath(new URL('./app/terminal.html', import.meta.url)),
      },
    },
    target: 'safari16',
    cssTarget: 'safari16',
    chunkSizeWarningLimit: 2500,
    outDir: '../dist',
    emptyOutDir: true,
    reportCompressedSize: false,
    sourcemap: false,
  },
  worker: { format: 'es' },
  optimizeDeps: {
    exclude: ['@wooorm/starry-night', '@shikijs/langs'],
  },
  test: {
    root: '.',
    environment: 'node',
    // Git-backed suites spawn native processes and watchers. Bound their shared concurrency.
    maxWorkers: 4,
    include: ['app/tests/**/*.test.{mjs,ts}'],
  },
  run: {
    tasks: {
      bundle: {
        command: 'vp build',
        cache: {
          env: ['NODE_ENV', 'VITE_*'],
          input: [
            { auto: true },
            'app/index.html',
            'app/terminal.html',
            'app/tsconfig.json',
            'app/renderer/**',
            'app/shared/**',
            'app/tooling/grammars/**',
            'branding/public/**',
            '!dist/**',
          ],
          output: ['dist/**'],
        },
      },
    },
  },
})
