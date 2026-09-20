import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { DefaultApolloClient } from '@vue/apollo-composable';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';

import App from './App.vue';
import router from './router';
import { apolloClient } from './api/client';

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(ElementPlus);
app.provide(DefaultApolloClient, apolloClient);

app.mount('#app');
