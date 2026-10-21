// 从上游打包好的(压缩过的)Node 服务端文件里,把某几个顶层函数连同它们依赖的全部顶层声明抽成一个独立的 ES 模块,
// 用来当「上游新版 JS」的对照基准。依赖 acorn:  npm install acorn
//
// 用法:
//   node extract-from-bundle.mjs <bundle.mjs> <输出.mjs> <名字1,名字2,...>     按压缩后的标识符名取
//   node extract-from-bundle.mjs <bundle.mjs> --find <正则>                     列出源码文本匹配该正则的顶层声明(帮你找名字)
//
// 注意:压缩后的标识符名只对某个具体版本成立(v0.1.336 的名字换一版就变),所以先用 --find 按特征字符串定位。
// 只抽「声明」,不执行顶层的副作用语句(启动服务、监听端口等);抽出来的模块里如果引用了它们才会出错,出错时报缺哪个名字。
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const acorn = require('acorn')

const [, , bundlePath, arg2, arg3] = process.argv
const src = readFileSync(bundlePath, 'utf8')
const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' })

const patternNames = (p, out = []) => {
  if (!p) return out
  if (p.type === 'Identifier') out.push(p.name)
  else if (p.type === 'ObjectPattern') p.properties.forEach((x) => patternNames(x.type === 'RestElement' ? x.argument : x.value, out))
  else if (p.type === 'ArrayPattern') p.elements.forEach((x) => patternNames(x, out))
  else if (p.type === 'RestElement') patternNames(p.argument, out)
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out)
  return out
}
const declared = new Map() // 名字 -> 顶层语句下标
ast.body.forEach((n, i) => {
  if (n.type === 'VariableDeclaration') n.declarations.forEach((d) => patternNames(d.id).forEach((nm) => declared.set(nm, i)))
  else if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') declared.set(n.id.name, i)
  else if (n.type === 'ImportDeclaration') n.specifiers.forEach((s) => declared.set(s.local.name, i))
})
// 语句里引用到的标识符(宁可多不可少:属性名之外的所有 Identifier)
const refsOf = (node) => {
  const out = new Set()
  const walk = (n, parent, key) => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'Identifier') {
      const isPropName = parent && ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed) || (parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand))
      if (!isPropName) out.add(n.name)
    }
    for (const k of Object.keys(n)) {
      const v = n[k]
      if (Array.isArray(v)) v.forEach((c) => walk(c, n, k))
      else if (v && typeof v.type === 'string') walk(v, n, k)
    }
  }
  walk(node, null, null)
  return out
}

if (arg2 === '--find') {
  const re = new RegExp(arg3)
  ast.body.forEach((n, i) => {
    const text = src.slice(n.start, n.end)
    if (!re.test(text) || n.type === 'ImportDeclaration') return
    const names = n.type === 'VariableDeclaration' ? n.declarations.flatMap((d) => patternNames(d.id)) : n.id ? [n.id.name] : ['(语句)']
    console.log(`#${i} ${n.type} ${names.join(',')}  ${text.length} 字节`)
  })
  process.exit(0)
}

const roots = arg3.split(',').map((s) => s.trim()).filter(Boolean)
const need = new Set(), queue = [...roots]
const missing = new Set()
while (queue.length) {
  const nm = queue.pop()
  if (!declared.has(nm)) { if (roots.includes(nm)) missing.add(nm); continue }
  const idx = declared.get(nm)
  if (need.has(idx)) continue
  need.add(idx)
  for (const r of refsOf(ast.body[idx])) if (declared.has(r) && !need.has(declared.get(r))) queue.push(r)
}
if (missing.size) { console.error('找不到顶层声明:', [...missing].join(', ')); process.exit(1) }
const picked = [...need].sort((a, b) => a - b)
let outText = picked.map((i) => src.slice(ast.body[i].start, ast.body[i].end)).join('\n') + '\n'
outText += `export { ${roots.join(', ')} }\n`
writeFileSync(arg2, outText)
console.log(`抽出 ${picked.length} 条顶层声明(其中 import ${picked.filter((i) => ast.body[i].type === 'ImportDeclaration').length} 条),共 ${outText.length} 字节 → ${arg2}`)
