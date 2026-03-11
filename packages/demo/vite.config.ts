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
  server: {
    host: true, // Listen on all interfaces (0.0.0.0) for LAN access
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    proxy: {
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
});
