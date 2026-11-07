import { createRouter, createWebHashHistory } from 'vue-router'

/**
 * 用 hash 模式而不是 history 模式，理由只有一个：
 * GitHub Pages 无法给任意子路径做 SPA 回退（没有 rewrite 规则），
 * history 模式刷新 /play/xxx 会 404；hash 模式在 Pages、file://、后端静态托管下都成立。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('./app/pages/HomePage.vue') },
    { path: '/play/:matchId', name: 'play', component: () => import('./app/pages/PlayPage.vue') },
    { path: '/result/:matchId', name: 'result', component: () => import('./app/pages/ResultPage.vue') },
    { path: '/join', name: 'join', component: () => import('./app/pages/JoinPage.vue') },
    { path: '/room/:code', name: 'room', component: () => import('./app/pages/RoomPage.vue') },
    { path: '/settings', name: 'settings', component: () => import('./app/pages/SettingsPage.vue') },
    { path: '/about', name: 'about', component: () => import('./app/pages/AboutPage.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior() {
    return { top: 0 }
  },
})
