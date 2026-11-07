<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import { APP_VERSION, MODE_LABEL } from '@/env.ts'
import { room } from '@/stores/matchStore.ts'

/**
 * 顶栏的模式标签是「事实标签」而不是「配置标签」：
 * 静态站也带联机入口，所以只有真的握上手才写「联机模式」，否则写构建期的默认形态。
 */
const modeText = computed(() => {
  if (room.connected) return room.lobby ? `联机 · 房间 ${room.lobby.room_code}` : '联机模式'
  return MODE_LABEL
})
</script>

<template>
  <header class="topbar">
    <RouterLink class="brand" to="/">
      <span class="brand-mark">AI</span>
      <span>信息素养训练场</span>
    </RouterLink>

    <nav class="nav">
      <RouterLink to="/">首页</RouterLink>
      <RouterLink to="/join">联机大厅</RouterLink>
      <RouterLink to="/settings">设置</RouterLink>
      <RouterLink to="/about">关于</RouterLink>
    </nav>

    <div class="topbar-right">
      <span class="tag" :class="{ ok: room.connected }">{{ modeText }}</span>
      <span class="tiny mono">v{{ APP_VERSION }}</span>
    </div>
  </header>

  <RouterView v-slot="{ Component }">
    <Transition name="fade" mode="out-in">
      <component :is="Component" />
    </Transition>
  </RouterView>
</template>
