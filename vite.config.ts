import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, host: true },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        /**
         * Only three's CORE goes in the shared chunk. Listing the whole package
         * dragged the addons in with it -- including GLTFLoader and DRACOLoader,
         * which are behind a dynamic import precisely so they are not downloaded
         * unless an authored model exists. Letting addons follow their importer
         * keeps that lazy chunk lazy.
         */
        manualChunks(id) {
          if (id.includes('/node_modules/three/build/')) return 'three';
          if (id.includes('/node_modules/@supabase/')) return 'supabase';
          return undefined;
        },
      },
    },
  },
});
