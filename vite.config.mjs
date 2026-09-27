import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The renderer never talks to the network itself (everything goes through the preload bridge),
// so the shipped page can be locked down hard. Message bodies render in a sandboxed iframe that
// inherits this policy and adds its own stricter one.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: http:",
  "font-src 'self' data: https:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [
    react(),
    {
      name: 'classicmail-csp',
      transformIndexHtml(html) {
        return command === 'build' ? html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}">`) : html.replace('<!--CSP-->', '');
      }
    }
  ],
  define: {
    // The demo data used for screenshots and browser-only development is left out of real builds.
    __WITH_MOCK__: JSON.stringify(command === 'serve' || process.env.CM_MOCK === '1')
  },
  build: { outDir: process.env.CM_OUT || 'dist', emptyOutDir: true, sourcemap: false, target: 'chrome120' },
  server: { port: 5173, strictPort: true }
}));
