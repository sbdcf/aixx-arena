<script setup lang="ts">
import { computed } from 'vue'

/** 题板：55 题考试里最要紧的导航器官，一眼看清「哪些没答、哪些存疑」 */
const props = defineProps<{
  total: number
  current: number
  answered: Record<string, string[]>
  questions: { id: string }[]
  flags: string[]
  /** 团队赛的题序由团队共享游标决定，题板只作状态显示、不能跳题 */
  interactive?: boolean
}>()

const emit = defineEmits<{ go: [index: number] }>()

const flagSet = computed(() => new Set(props.flags))
const clickable = computed(() => props.interactive !== false)

function stateOf(index: number): Record<string, boolean> {
  const qid = props.questions[index]?.id
  return {
    answered: qid ? Boolean(props.answered[qid]?.length) : false,
    current: index === props.current,
    flagged: qid ? flagSet.value.has(qid) : false,
  }
}
</script>

<template>
  <div>
    <div class="panel-title">答题卡</div>
    <div class="palette">
      <button
        v-for="(_, index) in total"
        :key="index"
        type="button"
        :class="[stateOf(index), { locked: !clickable }]"
        :title="clickable ? `第 ${index + 1} 题` : `第 ${index + 1} 题（团队赛题序由主答推进）`"
        :disabled="!clickable"
        @click="clickable && emit('go', index)"
      >
        {{ index + 1 }}
      </button>
    </div>
    <div class="legend" style="margin-top: 12px">
      <span><i style="background: var(--brand-soft); border-color: #bcd3fb" />已答</span>
      <span><i style="background: #fff" />未答</span>
      <span><i style="background: var(--warn-soft); border-color: #f0d3a8" />存疑</span>
    </div>
  </div>
</template>
