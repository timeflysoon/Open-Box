// 分组 / 出站名的合法性校验(对齐上游 v0.1.495 起统一的 outboundNameInvalid 文案):
// 名字会直接当内核里的出站 tag 用,`.` / `..` / 含 `/` 的写法会被内核当作路径或非法 tag,
// 所以这三种一律拒绝。空名由调用方按各自文案处理(各组提示不一样)。
export const isInvalidOutboundName = (name: string): boolean => {
  const n = (name ?? '').trim()
  if (n === '' ) return false // 空名交给调用方报「请填写名称」
  if (n === '.' || n === '..') return true
  return n.includes('/')
}
