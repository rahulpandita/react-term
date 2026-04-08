import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@next_term/core": path.resolve(__dirname, "../core/src/index.ts"),
      "@next_term/web": path.resolve(__dirname, "../web/src/index.ts"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, "index.html"),
        xterm: path.resolve(__dirname, "xterm.html"),
        "react-term": path.resolve(__dirname, "react-term.html"),
        "jank-demo": path.resolve(__dirname, "jank-demo.html"),
      },
    },
  },
  server: {
    port: 5180,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    proxy: {
      "/ws": {
        target: "ws://localhost:8090",
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
});
