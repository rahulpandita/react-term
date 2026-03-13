import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@react-term/core': path.resolve(__dirname, '../core/src/index.ts'),
      '@react-term/web': path.resolve(__dirname, '../web/src/index.ts'),
      '@react-term/react': path.resolve(__dirname, '../react/src/index.ts'),
    },
  },
  build: {
    rollupOptions: {
      external: ['ghostty-web'],
    },
  },
  optimizeDeps: {
    exclude: ['ghostty-web'],
  },
  server: {
    port: 5174,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
});
