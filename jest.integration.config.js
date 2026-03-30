/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/integration'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  // Transform ESM-only dependencies (pixelmatch is pure ESM)
  transformIgnorePatterns: ['/node_modules/(?!pixelmatch)'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.jsx?$': ['ts-jest', { tsconfig: { allowJs: true } }],
  },
};
