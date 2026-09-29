/** TEST PRELOAD ONLY. Never used by Agent production startup. */
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const root = path.resolve(__dirname, '..');
const operatorFiles = new Set([
  path.join(root, 'apps/agent/.env'), path.join(root, '.env'), path.resolve(root, '../.env'),
]);
const isOperatorFile = (file) => typeof file === 'string' && operatorFiles.has(path.resolve(file));
const read = fs.readFileSync;
const exists = fs.existsSync;
fs.readFileSync = function (file, ...args) {
  if (isOperatorFile(file)) throw Error('Hermetic test attempted to read operator configuration');
  return read.call(this, file, ...args);
};
if (process.env.ARCHCORE_TEST_OPERATOR_ENV === 'absent') {
  fs.existsSync = function (file) { return isOperatorFile(file) ? false : exists.call(this, file); };
}
syncBuiltinESMExports();
