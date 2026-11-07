import './styles/base.css'
import { createApp } from 'vue'
import App from './app/App.vue'
import { router } from './router.ts'

createApp(App).use(router).mount('#app')
