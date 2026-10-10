<template>
  <div
    :class="
      title
        ? 'relative flex h-36 w-full flex-col overflow-hidden rounded-xl border border-base-300/60 bg-base-100 p-2'
        : 'relative h-28 w-full overflow-hidden'
    "
  >
    <!-- 带标题:标题在左上、暂停键在右上,不画图例(概览页四张图用) -->
    <div
      v-if="title"
      class="flex h-6 shrink-0 items-center justify-between px-1"
    >
      <span class="text-base-content/70 truncate text-xs">{{ title }}</span>
      <button
        class="btn btn-ghost btn-xs btn-circle"
        @click="isPaused = !isPaused"
      >
        <component
          :is="!isPaused ? PauseCircleIcon : PlayCircleIcon"
          class="h-4 w-4"
        />
      </button>
    </div>
    <div
      ref="chart"
      :class="title ? 'min-h-0 w-full flex-1' : 'h-full w-full'"
    />
    <span
      class="border-b-primary/30 border-t-primary/60 border-l-info/30 border-r-info/60 text-base-content/10 bg-base-100/70 hidden"
      ref="colorRef"
    />
    <!-- 暂停键:概览和规则页的图有,侧边栏那张小图不放(pausable=false) -->
    <button
      v-if="!title && pausable !== false"
      class="btn btn-ghost btn-xs absolute right-1 bottom-0"
      @click="isPaused = !isPaused"
    >
      <component
        :is="!isPaused ? PauseCircleIcon : PlayCircleIcon"
        class="h-4 w-4"
      />
    </button>
  </div>
</template>

<script setup lang="ts">
import { cssColorToRgb, isMiddleScreen } from '@/helper/utils'
import { isWindowResizing } from '@/helper/windowResizeState'
import { font, theme } from '@/store/settings'
import { PauseCircleIcon, PlayCircleIcon } from '@heroicons/vue/24/outline'
import { useElementSize } from '@vueuse/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { debounce } from 'lodash'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

// 布尔 prop 不传时 Vue 会当成 false,所以「不传就有暂停键」得靠 withDefaults 写成 true
const props = withDefaults(defineProps<{
  data: { name: string; color?: number; data: { name: number; value: number }[] }[]
  // 右下角要不要放暂停键;不传就有
  pausable?: boolean
  // 带标题时画成独立卡片:标题在左上、暂停键在右上、不画图例
  title?: string
  // 单条曲线时指定颜色(进站 primary、出站 info);不传就按位置定
  tone?: 'primary' | 'info'
  // 鼠标悬停要不要弹数值浮层;不传就有(侧边栏那张小图关掉)
  tooltip?: boolean
  labelFormatter: (value: number) => string
  toolTipFormatter: (value: ToolTipParams[]) => string
  min: number
}>(), { pausable: true, tooltip: true })

const colorRef = ref()
const chart = ref()
const isPaused = ref(false)
const colorSet = {
  primary30: '',
  primary60: '',
  info30: '',
  info60: '',
  baseContent10: '',
  baseContent: '',
  base70: '',
}

let fontFamily = ''

const updateColorSet = () => {
  const colorStyle = getComputedStyle(colorRef.value)

  colorSet.baseContent = cssColorToRgb(colorStyle.getPropertyValue('--color-base-content'))
  colorSet.base70 = cssColorToRgb(colorStyle.backgroundColor)
  colorSet.baseContent10 = cssColorToRgb(colorStyle.color)
  colorSet.primary30 = cssColorToRgb(colorStyle.borderTopColor)
  colorSet.primary60 = cssColorToRgb(colorStyle.borderBottomColor)
  colorSet.info30 = cssColorToRgb(colorStyle.borderLeftColor)
  colorSet.info60 = cssColorToRgb(colorStyle.borderRightColor)
}
const updateFontFamily = () => {
  const baseColorStyle = getComputedStyle(colorRef.value)

  fontFamily = baseColorStyle.fontFamily
}

const options = computed(() => {
  return {
    // 画布本身已经离卡片边 8px(卡片 p-2),画布里的东西一律贴边:图例不留内边距、绘图区右边不留、
    // 纵轴标签从画布最左边开始。这样上下左右到卡片边都是 8px。
    legend: {
      show: !props.title,
      bottom: 0,
      padding: 0,
      data: props.data.map((item) => item.name),
      textStyle: {
        color: colorSet.baseContent,
        fontFamily,
      },
    },
    grid: {
      left: 60,
      // 绘图区上边距 8px,和卡片内边距一个数;最上面那个刻度标签半个字高在这 8px 里放得下
      top: 8,
      right: 0,
      // 图例没了 5px 内边距,绘图区和图例之间的间距保持原样
      bottom: props.title ? 4 : 20,
    },
    tooltip: {
      show: props.tooltip !== false,
      trigger: 'axis',
      backgroundColor: colorSet.base70,
      borderColor: colorSet.base70,
      confine: true,
      padding: [0, 5],
      textStyle: {
        color: colorSet.baseContent,
        fontFamily,
      },
      formatter: props.toolTipFormatter,
    },
    xAxis: {
      type: 'category',
      axisLine: { show: false },
      axisLabel: { show: false },
      splitLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      splitNumber: 4,
      max: (value: { max: number }) => {
        return Math.max(value.max, props.min)
      },
      axisLine: { show: false },
      splitLine: {
        show: true,
        lineStyle: {
          type: 'dashed',
          color: colorSet.baseContent10,
        },
      },
      axisLabel: {
        align: 'left',
        // 带标题的卡片不画最底下那个 0 刻度,曲线直接贴卡片底边(和 v0.1.308 一致)
        showMinLabel: props.title ? false : null,
        // 标签锚点在 grid.left - 8 = 52,往左推满 52 就贴到画布左边
        padding: [0, 0, 0, -52],
        formatter: props.labelFormatter,
        color: colorSet.baseContent,
        fontFamily,
      },
    },
    series: props.data.map((item, index) => {
      const usePrimary = props.tone ? props.tone === 'primary' : index === props.data.length - 1
      const seriesColor = usePrimary ? colorSet.primary60 : colorSet.info60
      const areaColor = usePrimary ? colorSet.primary30 : colorSet.info30

      return {
        name: item.name,
        symbol: 'none',
        emphasis: {
          disabled: true,
        },
        lineStyle: {
          width: 1,
        },
        data: item.data,
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            {
              offset: 0,
              color: seriesColor,
            },
            {
              offset: 1,
              color: areaColor,
            },
          ]),
        },
        type: 'line',
        color: seriesColor,
        smooth: true,
      }
    }),
  }
})

let myChart: echarts.ECharts | null = null
let touchEndHandler: ((e: TouchEvent) => void) | null = null
const resize = debounce(() => {
  myChart?.resize()
}, 220)

onMounted(() => {
  updateColorSet()
  updateFontFamily()

  watch(theme, updateColorSet)
  watch(font, updateFontFamily)

  myChart = echarts.init(chart.value)

  myChart.setOption(options.value)

  watch(options, () => {
    if (isPaused.value || isWindowResizing.value) {
      return
    }
    myChart?.setOption(options.value)
  })

  const { width } = useElementSize(chart)
  watch(width, resize)

  watch(isWindowResizing, (resizing) => {
    if (resizing || isPaused.value) {
      return
    }

    myChart?.setOption(options.value)
    resize()
  })

  // 移动端：松手后自动隐藏 tooltip
  if (isMiddleScreen.value && chart.value) {
    touchEndHandler = () => {
      if (myChart) {
        myChart.dispatchAction({ type: 'hideTip' })
      }
    }
    chart.value.addEventListener('touchend', touchEndHandler)
  }
})

onUnmounted(() => {
  resize.cancel()
  if (chart.value && touchEndHandler) {
    chart.value.removeEventListener('touchend', touchEndHandler)
  }
  if (myChart) {
    myChart.dispose()
    myChart = null
  }
})
</script>
