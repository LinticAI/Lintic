import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(() => {
  const backendPort = process.env.VITE_BACKEND_PORT ?? '3300';

  return {
    plugins: [
      tailwindcss(),
      react(),
    ],
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
      proxy: {
        '/api': `http://localhost:${backendPort}`,
      },
    },
  };
});
