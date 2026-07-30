import { defineConfig, loadEnv } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Read env from the repo-root .env (where all config lives). Only VITE_-prefixed vars are
// exposed to client code, so backend secrets in the same file never reach the bundle.
const envDir = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig(({ mode }) => {
  // DEV_PUBLIC_HOST opts a machine into being reachable through a public hostname
  // (e.g. a Cloudflare Tunnel in front of the dev server). Unset = local-only dev,
  // where Vite's defaults (localhost allowed, HMR on the page's own port) are right.
  const publicHost = loadEnv(mode, envDir, "").DEV_PUBLIC_HOST;

  return {
    plugins: [react(), tailwindcss()],
    envDir,
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      host: true,
      port: 5173,
      ...(publicHost && {
        allowedHosts: [publicHost],
        // The tunnel serves the page over https:443, so the HMR websocket must dial
        // back on 443 rather than Vite's local port.
        hmr: { clientPort: 443 },
      }),
    },
  };
});
