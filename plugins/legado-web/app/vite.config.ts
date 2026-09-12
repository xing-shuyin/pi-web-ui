import { defineConfig } from 'vite'

// 这份源码内嵌在 pi-web-ui 的 legado-web 插件里（plugins/legado-web/app/），
// 构建产物直接落到插件客户端静态目录 ../client/app/，由 pi-web-ui 的
// /plugins/legado-web/client/* 静态服务托管（宿主自带，无需插件再挂路由）。
//
// - base: './' —— 产物资源用相对路径，页面前缀（nginx 子路径 /pi/）与插件路径都自适应
// - 请求基址见 src/core/apiBase.ts：运行时按页面路径推导 /plugins-api/legado-web，
//   由插件服务端 index.mjs 的 /proxy（跨域+GBK 代理）与 /store（本地存储）承接
//
// 独立跑前端调试（可选）：npm run dev（此时没有同源 /proxy，需自己起一个）。
export default defineConfig({
  base: './',
  build: {
    outDir: '../client/app',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  preview: {
    port: 4173,
  },
})
