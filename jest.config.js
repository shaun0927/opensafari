/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // Exclude integration + daily-cron sentinel tests from default run.
  // - tests/integration/**   — require macOS + Xcode + booted Simulator
  // - tests/ci/**            — daily cron jobs (SimulatorKit HID sentinel, etc.)
  //                            run via .github/workflows/*.yml, not `npm test`
  // - tests/sentinel/**      — private API regression probes
  // - tests/soak/**          — 60-minute memory soak; requires OPENSAFARI_RUN_SOAK=1
  //                            run via .github/workflows/memory-soak.yml, not `npm test`
  // - tests/e2e-* / fixtures — live browser / app fixtures
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/integration/',
    '/tests/ci/',
    '/tests/sentinel/',
    '/tests/soak/',
    '/tests/e2e-',
    '/tests/fixtures/',
  ],
  // Transform ESM-only dependencies (pixelmatch is pure ESM)
  transformIgnorePatterns: ['/node_modules/(?!pixelmatch)'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.jsx?$': ['ts-jest', { tsconfig: { allowJs: true } }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: { branches: 0, functions: 0, lines: 0, statements: 0 },
  },
};
