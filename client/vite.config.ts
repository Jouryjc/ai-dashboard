import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  // Electron 打包后用 file:// 加载，资源路径必须相对
  base: './',
  server: {
    port: 5173,
    strictPort: true
  }
})
