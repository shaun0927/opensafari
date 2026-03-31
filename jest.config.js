/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // Exclude integration tests from default run (require macOS + Xcode + Simulator)
  testPathIgnorePatterns: ['/node_modules/', '/tests/integration/', '/tests/e2e-'],
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
