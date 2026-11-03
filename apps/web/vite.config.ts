import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
// A relative import, so Vite bundles it into the config (workspace packages are TS source).
import { classifySupabaseKey } from '../../packages/database/src/config';

/**
 * The workspace is a static app: everything it embeds is public. Like the desktop's build.rs,
 * refuse to build (or serve) when any VITE_* value (from the .env files or the process
 * environment, whatever its name) is a secret / service-role key or a Postgres connection string,
 * so neither can reach the bundle. Only the variable's name is ever printed, never its value.
 */
const POSTGRES_URL = /postgres(?:ql)?:\/\//i;
// classifySupabaseKey looks at the whole value; this also catches a secret key inside one.
const SECRET_KEY = /sb_secret_/i;

function refuseSecretKeys(mode: string) {
  // The .env files next to this config (whatever directory Vite was started from).
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (classifySupabaseKey(value) === 'secret' || SECRET_KEY.test(value)) {
      throw new Error(
        `${name} holds a secret / service-role key. The workspace may only embed the publishable key (docs/supabase.md).`,
      );
    }
    if (POSTGRES_URL.test(value)) {
      throw new Error(
        `${name} holds a Postgres connection string. The workspace may only embed the project URL and the publishable key (docs/supabase.md).`,
      );
    }
  }
}

export default defineConfig(({ mode }) => {
  refuseSecretKeys(mode);
  return {
    plugins: [react()],
    clearScreen: false,
    server: {
      port: 5180,
      strictPort: true,
      host: '127.0.0.1',
    },
    preview: {
      port: 5181,
      strictPort: true,
      host: '127.0.0.1',
    },
    envPrefix: ['VITE_'],
    build: {
      target: 'es2022',
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
    },
  };
});
