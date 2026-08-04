import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Ports are read from .env/.env.local so a developer running several projects at once
  // can move them without touching this file. The third arg '' disables the VITE_ prefix
  // filter, which is safe: loadEnv returns an object and does NOT mutate process.env, and
  // only VITE_-prefixed keys are ever inlined into client code. The defaults below are the
  // committed project defaults — with no .env present, behaviour is unchanged (8080/80/3001).
  const env = loadEnv(mode, process.cwd(), "");
  const devPort = Number(env.DEV_PORT) || 8080;
  const previewPort = Number(env.PREVIEW_PORT) || 80;
  const backendOrigin = env.BACKEND_ORIGIN || "http://localhost:3001";

  return {
    server: {
      host: "::",
      // strictPort: fail loudly instead of silently sliding to 8081, which on a machine
      // running several dev servers means "I am now on some other project's port".
      port: devPort,
      strictPort: true,
      proxy: {
        '/api': {
          target: backendOrigin,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    preview: {
      host: "0.0.0.0",
      port: previewPort,
      strictPort: true,
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
