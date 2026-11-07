<script setup lang="ts">
import { ref } from 'vue'
import { displayName, listMatches, loadProfile, removeMatch, saveProfile } from '@/storage/matchStorage.ts'

const profile = ref(loadProfile())
const saved = ref(false)
const records = ref(listMatches())

function save(): void {
  saveProfile({ nickname: profile.value.nickname.trim(), autoExplain: profile.value.autoExplain })
  saved.value = true
  window.setTimeout(() => {
    saved.value = false
  }, 1600)
}

function clearAll(): void {
  for (const record of records.value) removeMatch(record.match_id)
  records.value = listMatches()
}
</script>

<template>
  <main class="page" style="max-width: 760px">
    <div class="stack" style="gap: 16px">
      <section class="card">
        <h1>设置</h1>
        <p class="muted" style="margin-top: 8px">
          这些设置只保存在本机浏览器，不会上传到任何服务器（本地模式本来也没有服务器）。
        </p>
      </section>

      <section class="card">
        <div class="stack" style="gap: 16px">
          <div class="field">
            <label for="nick">称呼</label>
            <input id="nick" v-model="profile.nickname" class="input" maxlength="16" placeholder="例如：张三" />
            <span class="tiny muted">当前会显示为 <b>{{ displayName(profile) }}</b></span>
          </div>

          <label class="row" style="gap: 10px; cursor: pointer">
            <input v-model="profile.autoExplain" type="checkbox" />
            <span class="small">交卷后自动展开解析</span>
          </label>

          <div class="row">
            <button class="btn btn-primary" type="button" @click="save">保存设置</button>
            <span v-if="saved" class="tag tag-ok">已保存</span>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>本机练习记录</h2>
          <span class="spacer" />
          <span class="tag">{{ records.length }} 场</span>
        </div>
        <p class="small muted">清除后「继续练习」与历史成绩都会消失，且无法恢复。</p>
        <div class="row" style="margin-top: 14px">
          <button class="btn btn-danger" type="button" :disabled="records.length === 0" @click="clearAll">
            清空全部记录
          </button>
        </div>
      </section>
    </div>
  </main>
</template>
