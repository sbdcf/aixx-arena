<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 倒计时只做展示。
 * 真正的「时间到」由状态机的绝对 deadline 决定（LocalDriver 送 TICK、后端到点结算），
 * 所以这里即使偏了几百毫秒也不会影响判分，刷新页面也能立刻对上。
 */
const props = defineProps<{
  deadlineAt: number | null | undefined
  label?: string
}>()

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 200)
})

onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer)
})

const remaining = computed(() => (props.deadlineAt == null ? null : Math.max(0, props.deadlineAt - now.value)))

const text = computed(() => {
  if (remaining.value === null) return '--:--'
  const total = Math.ceil(remaining.value / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
})

const tone = computed(() => {
  if (remaining.value === null) return 'calm'
  if (remaining.value > 5 * 60_000) return 'calm'
  if (remaining.value > 60_000) return 'warn'
  return 'danger'
})
</script>

<template>
  <div>
    <div v-if="label" class="tiny muted" style="margin-bottom: 2px">{{ label }}</div>
    <div class="timer" :class="tone">{{ text }}</div>
  </div>
</template>
