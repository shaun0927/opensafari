/** @type {import('jest').Config} */
module.exports = {
  ...require('./jest.config'),
  roots: ['<rootDir>/tests/sentinel'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 60_000,
  forceExit: true,
  verbose: true,
};
