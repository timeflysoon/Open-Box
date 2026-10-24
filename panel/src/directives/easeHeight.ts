import type { Directive } from 'vue'

// v-ease-height="[依赖...]":依赖变化引起容器高度变化时,用 300ms 的缓动把高度从旧值过渡到新值
// (规则页的访问路径:查询结果回来、两列显示 / 隐藏时整块平滑撑开,而不是突然跳一下)
type EaseEl = HTMLElement & { __easeFrom?: number; __easeAnim?: Animation }

const sameDeps = (a: unknown, b: unknown) => {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((v, i) => Object.is(v, b[i]))
}

export const vEaseHeight: Directive<EaseEl, unknown> = {
  beforeUpdate(el, binding) {
    if (!sameDeps(binding.value, binding.oldValue)) el.__easeFrom = el.offsetHeight
  },
  updated(el) {
    const from = el.__easeFrom
    el.__easeFrom = undefined
    if (from === undefined) return
    el.__easeAnim?.cancel()
    const to = el.offsetHeight
    if (Math.abs(to - from) < 2) return
    el.style.overflow = 'clip'
    const anim = el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 300,
      easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
    })
    el.__easeAnim = anim
    const done = () => {
      if (el.__easeAnim !== anim) return
      el.style.overflow = ''
      el.__easeAnim = undefined
    }
    anim.onfinish = done
    anim.oncancel = done
  },
}
