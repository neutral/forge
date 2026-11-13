import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The cockpit server serves exactly /, /cockpit.js and /cockpit.css from apps/cockpit/
// (library/cockpit.mjs), and the application payload copies those files into web/.
// The build writes them there, under those names, as one script and one stylesheet.
export const output = fileURLToPath(new URL('../cockpit/', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  plugins: [react()],
  logLevel: 'warn',
  build: {
    outDir: output,
    emptyOutDir: true,
    assetsDir: '',
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: false,
    reportCompressedSize: false,
    rolldownOptions: {
      output: {
        entryFileNames: 'cockpit.js',
        assetFileNames: 'cockpit[extname]',
        banner: '/*! Forge cockpit. It bundles React, React DOM, React Aria Components and their dependencies; THIRD_PARTY.md in this distribution names each with its license. */',
        comments: { legal: true },
      },
    },
  },
});
