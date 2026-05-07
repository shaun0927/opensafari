const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'webpack.config.js', 'jest.config.js', 'jest.ci.config.js'],
  },
  // Source files (src/**/*.ts)
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        ecmaVersion: 2022,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  // CLI files — console.log allowed
  {
    files: ['cli/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.cli.json',
        ecmaVersion: 2022,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // CLI communicates via stdout, not MCP stdio — console.log is safe
    },
  },
  // ---------------------------------------------------------------------------
  // #710 WebKit RDP migration gate — per-path no-explicit-any: error
  //
  // These files were fully DTO-migrated under issue #710 (PR #739 / PR27).
  // The rule is intentionally NOT enforced globally; it gates only paths that
  // have been migrated away from raw `any` types.
  //
  // When future areas are migrated (Flutter VM service, simctl JSON, MCP tool
  // inputs, etc.) add their paths here as a separate PR that includes both
  // the migration commit and the lint-gate commit — per #710's incremental
  // contract ("lint strictness should follow migration, not precede it").
  // ---------------------------------------------------------------------------
  {
    files: [
      'src/types/webkit-rdp.ts',
      'src/webkit/client.ts',
      'tests/helpers/webkit-rdp-fixtures.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  // Test files
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.test.json',
        ecmaVersion: 2022,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
