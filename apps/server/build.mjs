// Bundles the server's own code and the workspace packages into one JavaScript file (dist/main.js), so a deployment runs
// plain Node instead of compiling TypeScript at startup (which needs a lot more memory and time). The server's own
// third-party dependencies stay as imports: some (the embedded database) load files that sit next to them. Anything
// else, such as a dependency of a workspace package, is bundled, because pnpm only links a package's own dependencies.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const own = Object.keys(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).dependencies).filter((name) => !name.startsWith('@warrant/'));
const packageName = (path) => (path.startsWith('@') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0]);

const ownDependencies = {
  name: 'own-dependencies-external',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => (own.includes(packageName(args.path)) ? { path: args.path, external: true } : undefined));
  },
};

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  plugins: [ownDependencies],
  // Bundled CommonJS packages call require(); give them one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});
