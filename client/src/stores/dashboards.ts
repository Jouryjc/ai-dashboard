/**
 * 首页「我的大屏」数据源：卡片列表、新建、改名、删除。
 * 用法：
 *   const store = useDashboardsStore()
 *   onMounted(() => store.fetchAll())
 *   store.sorted // 按最近修改排序的卡片
 *   await store.create('新大屏') // 返回新大屏，跳转 /workbench/:id
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'
import type { ArtifactKind, Dashboard } from '../types'

export const useDashboardsStore = defineStore('dashboards', () => {
  /* ---------- state ---------- */
  /** 全部大屏卡片 */
  const list = ref<Dashboard[]>([])
  /** 首次加载中 */
  const loading = ref(false)
  /** 是否已加载过 */
  const loaded = ref(false)

  /* ---------- getters ---------- */
  /** 按最近修改时间倒序（首页渲染顺序） */
  const sorted = computed<Dashboard[]>(() =>
    [...list.value].sort((a, b) => b.updatedAt - a.updatedAt)
  )
  /** 按 ID 查大屏：const d = store.byId('dash-1') */
  const byId = computed(() => (id: string): Dashboard | null =>
    list.value.find((d) => d.id === id) ?? null
  )

  /* ---------- 事件订阅（只订一次） ---------- */
  let subscribed = false
  function ensureSubscribed(): void {
    if (subscribed) return
    subscribed = true
    api.on('dashboardUpdated', ({ dashboard }) => applyUpdate(dashboard))
  }

  /* ---------- actions ---------- */
  /** 拉取列表（幂等，重复调用会刷新） */
  async function fetchAll(): Promise<void> {
    ensureSubscribed()
    loading.value = true
    try {
      list.value = await api.listDashboards()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** 新建大屏，返回新建的大屏（用于跳转工作台） */
  async function create(name: string, artifactKind: ArtifactKind = 'dashboard'): Promise<Dashboard> {
    ensureSubscribed()
    const d = await api.createProject(name, artifactKind)
    applyUpdate(d)
    return d
  }

  /** 改名 */
  async function rename(id: string, name: string): Promise<void> {
    await api.renameDashboard(id, name)
    const d = list.value.find((x) => x.id === id)
    if (d) {
      d.name = name
      d.updatedAt = Date.now()
    }
  }

  /** 删除 */
  async function remove(id: string): Promise<void> {
    await api.deleteDashboard(id)
    list.value = list.value.filter((d) => d.id !== id)
  }

  /** 内部：upsert 一张卡片（事件或本地变更都走这里） */
  function applyUpdate(d: Dashboard): void {
    const i = list.value.findIndex((x) => x.id === d.id)
    if (i >= 0) list.value[i] = d
    else list.value.push(d)
  }

  return {
    list, loading, loaded,
    sorted, byId,
    fetchAll, create, rename, remove
  }
})
