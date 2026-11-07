<script setup lang="ts">
import { computed } from 'vue'
import type { Question } from '@aixx/core'

/**
 * 题面 + 选项。纯展示 + 一个 select 事件，不碰任何判分逻辑：
 * 交卷前正确答案根本不在客户端（联机模式下），本地模式下也只由 reveal 帧给出。
 */
const props = defineProps<{
  question: Question
  index: number
  total: number
  selected: string[]
  disabled: boolean
  /** 交卷后由 reveal 帧填入 */
  reveal?: { answer: string[]; explain?: string } | null
  flagged: boolean
}>()

const emit = defineEmits<{
  select: [choice: string[]]
  toggleFlag: []
}>()

const typeLabel = computed(() => {
  switch (props.question.type) {
    case 'single':
      return '单选'
    case 'multiple':
      return '多选'
    default:
      return '判断'
  }
})

const showReveal = computed(() => Boolean(props.reveal && props.reveal.answer.length > 0))

function isCorrectOption(key: string): boolean {
  return props.reveal?.answer.includes(key) ?? false
}

function isWrongPick(key: string): boolean {
  return props.selected.includes(key) && !isCorrectOption(key) && showReveal.value
}

function optionState(key: string): Record<string, boolean> {
  return {
    selected: props.selected.includes(key),
    disabled: props.disabled,
  }
}

function pick(key: string): void {
  if (props.disabled) return
  if (props.question.type === 'multiple') {
    const next = props.selected.includes(key)
      ? props.selected.filter((item) => item !== key)
      : [...props.selected, key]
    emit('select', next.sort())
    return
  }
  emit('select', [key])
}
</script>

<template>
  <div>
    <div class="q-head">
      <span class="q-index">第 {{ index + 1 }} / {{ total }} 题</span>
      <span class="tag">{{ typeLabel }}</span>
      <span v-if="question.difficulty" class="tag">难度 {{ question.difficulty }}</span>
      <span class="spacer" />
      <button class="btn btn-sm btn-ghost" type="button" @click="emit('toggleFlag')">
        {{ flagged ? '★ 已标记' : '☆ 标记存疑' }}
      </button>
    </div>

    <div class="q-stem">{{ question.stem }}</div>

    <div v-if="question.stem_images?.length" class="q-images">
      <img v-for="image in question.stem_images" :key="image" :src="image" :alt="'题面图片'" loading="lazy" />
    </div>

    <div class="options">
      <div
        v-for="option in question.options"
        :key="option.key"
        class="option"
        :class="optionState(option.key)"
        role="button"
        :tabindex="disabled ? -1 : 0"
        @click="pick(option.key)"
        @keydown.enter.prevent="pick(option.key)"
        @keydown.space.prevent="pick(option.key)"
      >
        <span class="option-key">{{ option.key }}</span>
        <span class="option-text">{{ option.text }}</span>
        <span class="spacer" />
        <span v-if="showReveal && isCorrectOption(option.key)" class="tag tag-ok">正确答案</span>
        <span v-else-if="isWrongPick(option.key)" class="tag tag-danger">你的选择</span>
      </div>
    </div>

    <div v-if="showReveal && reveal?.explain" class="explain">{{ reveal.explain }}</div>
  </div>
</template>
