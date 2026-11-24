// Integration tests: files named *.int-spec.ts, run in band against local services.
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\.int-spec\.ts$',
  transform: { '^.+\.(t|j)s$': 'ts-jest' },
  setupFiles: ['<rootDir>/jest.setup.js'],
  testEnvironment: 'node',
  roots: ['<rootDir>/apps/'],
};
