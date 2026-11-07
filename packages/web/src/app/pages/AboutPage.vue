<script setup lang="ts">
import { APP_VERSION, MODE_LABEL } from '@/env.ts'

const formats = [
  {
    name: '个人客观题（校赛）',
    rule: '55 题 / 60 分钟，交卷后统一判分，可随时回改',
    impl: '纯静态，浏览器本地判分',
  },
  { name: '团队个人赛', rule: '10 题 / 5 分钟，队内各人独立作答后聚合', impl: '本地单人模拟；联机需后端' },
  { name: '团队赛（1 答 2 辅）', rule: '10 题 / 20 分钟，主答提交、辅助同屏可见', impl: '本地同屏模拟；联机需后端' },
  { name: '接力赛', rule: '3 棒 × 5 题，上一棒剩余时间继承给下一棒', impl: '本地一人三棒；联机需后端' },
  { name: '团队抢答', rule: '10 题，按服务端收到时间排序，前 50% 且答对才加分', impl: '本地模拟一队；联机需后端' },
]
</script>

<template>
  <main class="page" style="max-width: 860px">
    <div class="stack" style="gap: 16px">
      <section class="card">
        <h1>关于训练场</h1>
        <p class="muted" style="margin-top: 8px">
          这是「AI + 信息素养」大赛的练习场：五种赛制都能离线自练（团队赛可本地模拟），多人同场联机需要临时后端。
        </p>
        <div class="row" style="margin-top: 12px; flex-wrap: wrap">
          <span class="tag tag-brand">{{ MODE_LABEL }}</span>
          <span class="tag">v{{ APP_VERSION }}</span>
          <span class="tag">题库 87 题 · 12 考点</span>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>五种赛制</h2></div>
        <div class="stack" style="gap: 10px">
          <div v-for="format in formats" :key="format.name" class="review-item">
            <div class="row" style="gap: 8px; flex-wrap: wrap">
              <b>{{ format.name }}</b>
              <span class="spacer" />
              <span class="tag">{{ format.impl }}</span>
            </div>
            <div class="small muted" style="margin-top: 4px">{{ format.rule }}</div>
          </div>
        </div>
        <p class="tiny muted" style="margin-top: 12px">
          接力与抢答的题量、时长、计分细则以组委会最终通知为准，站内参数可在试卷 JSON 里调整，不需要改代码。
        </p>
      </section>

      <section class="card">
        <div class="card-head"><h2>数据与纠错</h2></div>
        <div class="stack" style="gap: 8px">
          <div class="small">· 题目来自公开资料整理，仅收录已核对答案（verified）的题目，共 87 道。</div>
          <div class="small">· 成绩页每题都有「报错 / 提 issue」入口，会带上题目 ID 与当前答案。</div>
          <div class="small">· 练习记录只存在本机浏览器，换设备不会同步。</div>
        </div>
      </section>

      <section class="card card-tight">
        <div class="row">
          <span class="small muted">备考站：</span>
          <a
            href="https://sbdcf.github.io/Guide-of-National-College-Student-Information-Literacy-Competition/"
            target="_blank"
            rel="noreferrer"
            >信息素养大赛备考指南</a
          >
        </div>
      </section>
    </div>
  </main>
</template>
