import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Standalone-сборка: всё складывается в одну папку и открывается двойным
 * кликом по index.html без веб-сервера и без Node.js.
 *
 *  • base: './'        — относительные пути к ассетам (работают по file://)
 *  • format: 'iife'    — классический <script>, а не module (module-скрипты
 *                        браузер блокирует при протоколе file://)
 *  • HashRouter        — маршруты вида #/services, не требуют сервера
 *
 * Сборка: npm run build:standalone  →  папка dist-standalone\
 */
export default defineConfig({
  plugins: [
    react(),
    {
      // Vite всегда помечает входной бандл как type="module", а такие скрипты
      // браузер блокирует при протоколе file://. Бандл собран в формате IIFE
      // (без import/export), поэтому безопасно подключить его обычным <script>.
      name: 'classic-script-for-file-protocol',
      enforce: 'post',
      transformIndexHtml: {
        order: 'post',
        handler(html: string) {
          return html
            .replace(
              /<script type="module" crossorigin src="([^"]+)"><\/script>/g,
              // defer обязателен: без него скрипт выполнится в <head> раньше,
              // чем появится контейнер #root, и React не сможет смонтировать приложение
              '<script src="$1" defer></script>',
            )
            .replace(/<link rel="stylesheet" crossorigin href=/g, '<link rel="stylesheet" href=')
        },
      },
    },
  ],
  base: './',
  build: {
    outDir: 'dist-standalone',
    emptyOutDir: true,
    target: 'es2018',
    modulePreload: false,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/app.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
