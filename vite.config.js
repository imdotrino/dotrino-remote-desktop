import { defineConfig } from 'vite'
import { execSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import prerender from '@dotrino/prerender/vite'

// Inyecta <meta name="commit"> con el hash del build (§3): permite verificar qué versión sirve
// el dominio y diagnosticar cachés viejas de SW/CDN.
function commitMeta () {
  let hash = 'dev'
  try { hash = execSync('git rev-parse --short HEAD').toString().trim() } catch {}
  return {
    name: 'commit-meta',
    transformIndexHtml (html) {
      return html.replace('</head>', `  <meta name="commit" content="${hash}" />\n</head>`)
    }
  }
}

// GitHub Pages no sabe de rutas de una SPA: una carpeta por ruta con la misma app, y
// `404.html` como red de seguridad para cualquier otra.
//  · `/`          la portada (informativa, §5.1).
//  · `/desktops`  tus escritorios (administrativa). La PWA instalada abre aquí.
function spaRoutes () {
  return {
    name: 'spa-routes',
    closeBundle () {
      copyFileSync('dist/index.html', 'dist/404.html')
      mkdirSync('dist/desktops', { recursive: true })
      copyFileSync('dist/index.html', 'dist/desktops/index.html')
    }
  }
}

export default defineConfig({
  base: '/',
  plugins: [prerender(), commitMeta(), spaRoutes()],
  resolve: { dedupe: ['@dotrino/identity', '@dotrino/proxy-client'] },
  server: { port: 3410, host: true }
})
