/**
 * 路由表。Electron 打包后走 file://，必须用 hash 模式。
 *  /            首页（我的大屏）
 *  /workbench/:id  工作台（三栏一屏式）
 *  /settings    设置中心
 */
import { createRouter, createWebHashHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('./pages/HomePage.vue') },
    { path: '/workbench/:id', name: 'workbench', component: () => import('./pages/WorkbenchPage.vue') },
    { path: '/settings', name: 'settings', component: () => import('./pages/SettingsPage.vue') }
  ]
})
