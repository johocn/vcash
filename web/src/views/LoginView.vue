<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const authStore = useAuthStore();

const form = reactive({ username: '', password: '' });
const loading = ref(false);

async function handleLogin() {
  if (!form.username || !form.password) {
    ElMessage.warning('请输入用户名和密码');
    return;
  }
  loading.value = true;
  try {
    await authStore.login(form.username, form.password);
    router.push('/setup');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '登录失败');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-container">
    <el-card class="login-card">
      <template #header>
        <h2 class="login-title">vcash POS</h2>
      </template>
      <el-form @submit.prevent="handleLogin" label-position="top">
        <el-form-item label="用户名">
          <el-input
            v-model="form.username"
            placeholder="请输入用户名"
            @keyup.enter="handleLogin"
          />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            placeholder="请输入密码"
            @keyup.enter="handleLogin"
          />
        </el-form-item>
        <el-form-item>
          <el-button
            type="primary"
            :loading="loading"
            style="width: 100%"
            @click="handleLogin"
          >
            登录
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.login-container {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: #f0f2f5;
}
.login-card {
  width: 400px;
}
.login-title {
  margin: 0;
  text-align: center;
  font-size: 20px;
}
</style>
