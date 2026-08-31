import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        admin: 'admin.html',
        pro: 'pro.html',
        onboarding: 'onboarding.html',
        platform: 'platform.html',
        legal: 'legal.html',
      },
    },
  },
});
