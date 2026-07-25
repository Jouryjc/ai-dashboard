/**
 * 版本抽屉开关状态（模块级单例）。
 * 抽屉本体渲染在右栏执行面板里（覆盖面板位置，UX §5.3），
 * 但打开入口在顶栏「↩版本」（topbar agent 负责）。
 * 顶栏用法：
 *   import { useVersionDrawer } from '../execution/useVersionDrawer'
 *   const { openVersionDrawer } = useVersionDrawer()
 *   // 点击「↩版本」时调 openVersionDrawer()
 */
import { ref } from 'vue'

const versionDrawerOpen = ref(false)

export function useVersionDrawer() {
  function openVersionDrawer(): void {
    versionDrawerOpen.value = true
  }
  function closeVersionDrawer(): void {
    versionDrawerOpen.value = false
  }
  function toggleVersionDrawer(): void {
    versionDrawerOpen.value = !versionDrawerOpen.value
  }
  return { versionDrawerOpen, openVersionDrawer, closeVersionDrawer, toggleVersionDrawer }
}
