import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Load a `.env` file if there is one: the working directory's, or the repository root's (the server is usually started from
 * `apps/server`). Variables already set in the environment win. Nothing is logged about the contents.
 */
export function loadEnvFile(cwd = process.cwd()): string | null {
  for (let dir = cwd, depth = 0; depth < 4; dir = dirname(dir), depth++) {
    const file = resolve(dir, '.env');
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return file;
    }
    if (dirname(dir) === dir) break;
  }
  return null;
}
