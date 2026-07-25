import { defineConfig } from 'vite';

export default defineConfig({
  build: { outDir: 'dist', emptyOutDir: true },
  server: { watch: { ignored: ['**/wailsjs/**'] } },
});
