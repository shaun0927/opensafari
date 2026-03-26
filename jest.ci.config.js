/** @type {import('jest').Config} */
module.exports = {
  ...require('./jest.config'),
  verbose: true,
  forceExit: true,
  detectOpenHandles: true,
};
