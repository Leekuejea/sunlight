import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';

// PDF.js needs its CMaps (CJK PDFs) and standard fonts served next to the app.
const copyPdfjsAssets = {
  name: 'copy-pdfjs-assets',
  closeBundle() {
    for (const dir of ['cmaps', 'standard_fonts']) fs.cpSync(`node_modules/pdfjs-dist/${dir}`, `dist/pdfjs/${dir}`, { recursive: true });
  },
};

export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react(), copyPdfjsAssets],
  build: { outDir: '../dist', emptyOutDir: true, target: ['es2022', 'safari15', 'chrome110'] },
});
