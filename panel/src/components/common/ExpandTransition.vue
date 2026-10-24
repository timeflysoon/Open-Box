<template>
  <!-- 展开 / 收起的高度动画:进入 300ms、离开 200ms;高度、内外边距、透明度一起过渡。
       父级是纵向 flex 且有 row-gap 时,把那一段间距也一并收掉(避免收起后留一条缝) -->
  <Transition
    :css="false"
    @enter="onEnter"
    @leave="onLeave"
  >
    <slot />
  </Transition>
</template>

<script setup lang="ts">
const EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'

type ExpandEl = HTMLElement & { __expandAnim?: Animation }

// 父级是纵向 flex 且有 row-gap:返回该元素要吃掉的那一侧间距
const gapSide = (el: HTMLElement) => {
  const parent = el.parentElement
  if (!parent) return null
  const style = getComputedStyle(parent)
  if (!style.display.includes('flex') || !style.flexDirection.startsWith('column')) return null
  const gap = parseFloat(style.rowGap) || 0
  if (!gap) return null
  if (el.previousElementSibling) return { side: 'marginTop' as const, gap }
  if (el.nextElementSibling) return { side: 'marginBottom' as const, gap }
  return null
}

const run = (node: Element, entering: boolean, duration: number, done: () => void) => {
  const el = node as ExpandEl
  el.__expandAnim?.cancel()
  const cs = getComputedStyle(el)
  const full: Record<string, string | number> = {
    height: `${el.offsetHeight}px`,
    paddingTop: cs.paddingTop,
    paddingBottom: cs.paddingBottom,
    marginTop: cs.marginTop,
    marginBottom: cs.marginBottom,
    opacity: 1,
  }
  const zero: Record<string, string | number> = {
    height: '0px',
    paddingTop: '0px',
    paddingBottom: '0px',
    marginTop: '0px',
    marginBottom: '0px',
    opacity: 0,
  }
  const gap = gapSide(el)
  if (gap) zero[gap.side] = `${-gap.gap}px`
  el.style.overflow = 'clip'
  const anim = el.animate(entering ? [zero, full] : [full, zero], { duration, easing: EASING })
  el.__expandAnim = anim
  const finish = () => {
    if (el.__expandAnim !== anim) return
    el.style.overflow = ''
    el.__expandAnim = undefined
    done()
  }
  anim.onfinish = finish
  anim.oncancel = finish
}

const onEnter = (el: Element, done: () => void) => run(el, true, 300, done)
const onLeave = (el: Element, done: () => void) => run(el, false, 200, done)
</script>
