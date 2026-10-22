// Shared by isolated browser QA harnesses, including on Windows and in paths
// containing spaces. Vite wants native paths; Node's ESM loader wants URLs.
import {createRequire} from 'node:module';
import {isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export function browserPaths(scriptUrl, env = process.env) {
  const webRoot = resolve(env.OCTIQ_WEB_ROOT || fileURLToPath(new URL('../web', scriptUrl)));
  const moduleUrl = spec => isAbsolute(spec) || spec.startsWith('.') ? pathToFileURL(resolve(spec)).href : spec;
  return {webRoot, require: createRequire(join(webRoot, 'package.json')), moduleUrl};
}
