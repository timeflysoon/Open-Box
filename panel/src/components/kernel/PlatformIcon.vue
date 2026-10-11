<template>
  <!-- 平台小图标:OpenWrt 用青色圆环里一个无线信号,Linux 用一只简笔企鹅(都是自绘的通用图形) -->
  <svg
    v-if="name === 'openwrt'"
    viewBox="0 0 32 32"
    aria-hidden="true"
  >
    <circle
      cx="16"
      cy="16"
      r="14"
      fill="none"
      stroke="#1fb8d6"
      stroke-width="2.4"
    />
    <path
      d="M8.5 14.2a10.6 10.6 0 0 1 15 0M11.6 17.6a6.2 6.2 0 0 1 8.8 0"
      fill="none"
      stroke="#1fb8d6"
      stroke-width="2.4"
      stroke-linecap="round"
    />
    <circle
      cx="16"
      cy="21.4"
      r="1.8"
      fill="#1fb8d6"
    />
  </svg>
  <svg
    v-else
    viewBox="0 0 32 32"
    aria-hidden="true"
  >
    <ellipse
      cx="11.4"
      cy="29"
      rx="3.8"
      ry="1.7"
      fill="#f59e0b"
    />
    <ellipse
      cx="20.6"
      cy="29"
      rx="3.8"
      ry="1.7"
      fill="#f59e0b"
    />
    <ellipse
      cx="16"
      cy="17.5"
      rx="9.5"
      ry="11.5"
      fill="#374151"
    />
    <ellipse
      cx="16"
      cy="20.5"
      rx="5.8"
      ry="8"
      fill="#fff"
    />
    <circle
      cx="12.6"
      cy="11.2"
      r="1.9"
      fill="#fff"
    />
    <circle
      cx="19.4"
      cy="11.2"
      r="1.9"
      fill="#fff"
    />
    <circle
      cx="12.9"
      cy="11.4"
      r="0.9"
      fill="#111827"
    />
    <circle
      cx="19.1"
      cy="11.4"
      r="0.9"
      fill="#111827"
    />
    <path
      d="M13.4 14.2 16 17l2.6-2.8z"
      fill="#f59e0b"
    />
  </svg>
</template>

<script setup lang="ts">
defineProps<{
  name: 'openwrt' | 'linux'
}>()
</script>
