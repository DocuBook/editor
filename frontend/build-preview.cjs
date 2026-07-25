// Build standalone preview bundle (esbuild — Vite can't handle @mdx-js/mdx deps)
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['preview/preview.tsx'],
  bundle: true,
  outfile: 'public/preview.js',
  format: 'iife',
  globalName: 'EditorPreview',
  loader: { '.tsx': 'tsx' },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'resolve-mdx',
    setup(build) {
      // Mark vfile's subpath imports as external (breaks Rollup, fine in esbuild)
      build.onResolve({ filter: /^#/ }, (args) => {
        return { path: args.path, external: true };
      });
    }
  }]
}).catch(() => process.exit(1));
