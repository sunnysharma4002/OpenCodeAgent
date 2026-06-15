const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').Plugin} */
const lazyRequirePlugin = {
  name: 'lazy-require',
  setup(build) {
    build.onResolve({ filter: /[\\/]vscode/ }, (args) => ({
      path: args.path,
      external: true
    }));
  }
};

/** @type {import('esbuild').BuildOptions} */
const baseConfig = {
  bundle: true,
  entryPoints: ['src/extension.ts'],
  external: ['vscode'],
  format: 'cjs',
  mainFields: ['module', 'main'],
  outfile: 'dist/extension.js',
  platform: 'node',
  plugins: [lazyRequirePlugin],
  sourcemap: !production,
  sourcesContent: false,
  target: ['node20']
};

async function main() {
  const ctx = await esbuild.context(baseConfig);
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
