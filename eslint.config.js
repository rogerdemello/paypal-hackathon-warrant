import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// packages/warrant must stay a pure function library: no network, no database, no filesystem, no clock,
// no randomness inside src/. These rules make that a lint failure instead of a code-review convention.
const warrantPurity = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: [
            'node:fs',
            'node:fs/*',
            'node:net',
            'node:tls',
            'node:dns',
            'node:dns/*',
            'node:http',
            'node:https',
            'node:http2',
            'node:dgram',
            'node:child_process',
            'node:cluster',
            'node:worker_threads',
            'node:readline',
            'node:inspector',
            'fs',
            'fs/*',
            'net',
            'tls',
            'dns',
            'http',
            'https',
            'http2',
            'dgram',
            'child_process',
            'pg',
            'pg-*',
            'postgres',
            'undici',
            'node-fetch',
            'axios',
            'ws',
            '@warrant/paypal',
            '@warrant/catalog',
            '@warrant/mcp',
            '@warrant/server',
          ],
          message: 'packages/warrant must not perform or depend on I/O. Pass data in as arguments.',
        },
      ],
    },
  ],
  'no-restricted-globals': [
    'error',
    { name: 'fetch', message: 'packages/warrant must not perform network I/O.' },
    { name: 'XMLHttpRequest', message: 'packages/warrant must not perform network I/O.' },
    { name: 'WebSocket', message: 'packages/warrant must not perform network I/O.' },
    { name: 'process', message: 'packages/warrant must not read the environment.' },
    { name: 'console', message: 'packages/warrant must not log. Return data instead.' },
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Date', property: 'now', message: 'Take `now` as an argument so results stay deterministic.' },
    { object: 'Math', property: 'random', message: 'Take randomness as an argument so results stay deterministic.' },
    { object: 'crypto', property: 'randomUUID', message: 'Take identifiers as arguments.' },
    { object: 'crypto', property: 'getRandomValues', message: 'Take randomness as an argument.' },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "NewExpression[callee.name='Date'][arguments.length=0]",
      message: 'new Date() reads the clock. Take `now` as an argument.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/playwright-report/**',
      '**/test-results/**',
      // Private strategy notes. Never linted, never published.
      '_strategy/**',
      // A separate project (its own git history and tooling) that sits in this folder. Not part of Warrant.
      'ms-cockpit-simulation/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['packages/warrant/src/**/*.ts'],
    rules: warrantPurity,
  },
  {
    // The web app runs in a browser and is written in React.
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // Event handlers and effects hand promises to React on purpose.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
  {
    // Tests deliberately build malformed and untyped inputs.
    files: ['**/test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
);
