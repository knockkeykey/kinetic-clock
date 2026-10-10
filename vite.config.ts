import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// 开发时用 HTTPS：手机通过局域网 IP 访问也是安全上下文，陀螺仪和定位才可用
// GitHub Pages 部署在 /kinetic-clock/ 子路径下
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/kinetic-clock/' : './',
  plugins: [basicSsl()],
})
