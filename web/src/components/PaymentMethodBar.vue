<script setup lang="ts">
defineEmits<{
  (e: 'cash'): void;
  (e: 'aggregate'): void;
}>();
</script>

<template>
  <div class="payment-method-bar">
    <el-button class="pay-btn cash" size="large" @click="$emit('cash')">
      <span class="icon">💵</span>
      <span class="label">现金</span>
    </el-button>
    <el-button class="pay-btn aggregate" size="large" @click="$emit('aggregate')">
      <span class="icon">📱</span>
      <span class="label">聚合码</span>
    </el-button>
  </div>
</template>

<style scoped>
.payment-method-bar {
  display: flex;
  gap: 24px;
  justify-content: center;
}
.pay-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 200px;
  height: 160px;
  border-radius: 12px;
  font-size: 20px;
}
.pay-btn .icon {
  font-size: 40px;
}
.pay-btn .label {
  font-size: 20px;
  font-weight: 600;
}
.pay-btn.cash {
  background: #67c23a;
  color: #fff;
  border-color: #67c23a;
}
.pay-btn.cash:hover {
  background: #5daf34;
  border-color: #5daf34;
}
.pay-btn.aggregate {
  background: #409eff;
  color: #fff;
  border-color: #409eff;
}
.pay-btn.aggregate:hover {
  background: #337ecc;
  border-color: #337ecc;
}
</style>
