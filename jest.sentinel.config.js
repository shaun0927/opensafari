/** @type {import('jest').Config} */
module.exports = {
  ...require('./jest.config'),
  roots: ['<rootDir>/tests/sentinel'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 75_000,
  verbose: true,
};
