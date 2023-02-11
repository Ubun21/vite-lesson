import koa from 'koa'
import fs from 'fs/promises'
import path from 'path'
import resolve from 'resolve-from'
import staticSever from 'koa-static'
import { parse } from '@babel/parser'
import MagicString from 'magic-string'
import { 
  parse as sfcParse, 
  compileTemplate, 
  compileStyle
} from '@vue/compiler-sfc'
import svgToTinyDataUri from 'mini-svg-data-uri'
import hash from 'hash-sum'
import chokidar from 'chokidar'
import { WebSocketServer } from 'ws'
import url from 'url'

const app = new koa()
const root = process.cwd() // 项目运行的文件路径
const moduleIdCache = new Map()



app.use(async (ctx, next) => {
  if (ctx.path === '/') {
    ctx.redirect('/index.html')
    return
  }
  await next()
}).use(moduleRewrite)
  .use(nodeModuleResolve)
  .use(sfcComplie)
  .use(convertSvgToDataUri)
  .use(handleCss)

async function handleCss(ctx, next) {
  if (!ctx.path.endsWith('.css')) {
    return next()
  }

  const path = root + ctx.path

  let content
  try {
    content = (await fs.readFile(path, 'utf-8')).toString()
  } catch (error) {
    ctx.status = 404
    return
  }


  let str = `
  const styleId = 'vue-global-${hash(path)}'
  const style = document.createElement('style')
  style.id = styleId
  document.head.appendChild(style)
  style.textContent = ${JSON.stringify(content)}
`
  ctx.type = 'js'
  ctx.body = str
  return
}

async function convertSvgToDataUri(ctx, next) {
  if (!ctx.path.endsWith('.svg')) {
    return next()
  }

  const path = root + ctx.path
  let content
  try {
    content = (await fs.readFile(path, 'utf-8')).toString()
  } catch (error) {
    ctx.status = 404
    return
  }
  const dataUrl = svgToTinyDataUri(content)
  ctx.type = 'js'
  ctx.body = `
    let url = "${dataUrl}"
    export default url
  `
  return
}  

async function sfcComplie(ctx, next) {
  if (!ctx.path.endsWith('.vue')) {
    return next()
  }

  const parsed = url.parse(ctx.url, true)
  const pathname = parsed.pathname
  const query = parsed.query
  const filename = path.join(root, pathname.slice(1))
  const [descriptor] = await parseSFC(filename, true)
  if (!descriptor) {
    ctx.status = 404
    return
  }
  // 首次请求
  if (!query.type) {
    return compileSFCMain(ctx, descriptor, pathname, query.t)
  }

  if (query.type === 'template') {
    return compileSFCTemplate(
      ctx, 
      descriptor.template, 
      filename,
      pathname
      )
  }

  if (query.type === 'style') {
    return compileSFCStyle(
      ctx,
      descriptor.styles[Number(query.index)],
      query.index,
      filename,
      pathname
    )
  }
}

function compileSFCMain(
  ctx,
  descriptor,
  pathname,
  timestamp
) {
  timestamp = timestamp ? `&t=${timestamp}` : ``
  let code = ''
  if (descriptor.script) { // let __script; export default (__script = 
    code += rewrite(
      descriptor.script.content,
      true /* rewrite default export to `script` */
    )
  } else {
    code += `const __script = {}; export default __script`
  }

  if (descriptor.styles) {
    descriptor.styles.forEach((_, i) => {
      code += `\nimport ${JSON.stringify(
        pathname + `?type=style&index=${i}${timestamp}`
      )}`
    })
  }
  if (descriptor.template) {
    code += `\nimport { render as __render } from ${JSON.stringify(
      pathname + `?type=template${timestamp}`
    )}`
    code += `\n__script.render = __render`
  }

  code += `\n__script.__hmrId = ${JSON.stringify(pathname)}`
  sendJS(ctx, code)
}

function compileSFCTemplate(
  ctx,
  template,
  filename,
) {
  const { code, errors } = compileTemplate({
    source: template.content,
    filename,
    id: ''
  })

  if (errors.length) {
    ctx = 500
    return
  }
  sendJS(ctx, code)
}

function compileSFCStyle(
  ctx,
  style,
  index,
  filename,
  pathname
) {
  const id = hash(pathname)
  const { code, errors } = compileStyle({
    source: style.content,
    filename,
    id: ''
  })

  if (errors.length) {
    ctx.status = 500
    return
  }
  sendJS(
    ctx,
    `
const id = "vue-style-${id}-${index}"
let style = document.getElementById(id)
if (!style) {
  style = document.createElement('style')
  style.id = id
  document.head.appendChild(style)
}
style.textContent = ${JSON.stringify(code)}
  `.trim()
  )
}

export function send(
  ctx,
  source,
  mine
) {
  ctx.set('Content-type', mine)
  ctx.body = rewrite(source)
}

export function sendJS(ctx, source) {
  send(ctx, source, 'application/javascript')
}

async function nodeModuleResolve(ctx, next) {
  if (!ctx.path.startsWith('/@modules')) {
    return next()
  }

  // vue是特殊情况
  if (ctx.path.endsWith('vue')) {
    let vuePath
    let vueSource
    try {
      const userVuePkg = resolve(root, 'vue/package.json')
      vuePath = path.join(
        path.dirname(userVuePkg),
        'dist/vue.runtime.esm-browser.js'
      )
      vueSource = (await fs.readFile(vuePath, 'utf-8')).toString()
    } catch (error) {
      ctx.status = 404
      return
    } 
    ctx.type = 'js'
    ctx.body = vueSource
    return
  }

  // 其他node_modules依赖
  let modulePath
  let source
  const id = moduleIdCache.get(ctx.path)
  try {
    modulePath = resolve(root, `${id}/package.json`)
    // module resolved, try to locate its "module" entry
    const pkg = JSON.parse((await fs.readFile(modulePath, 'utf-8')).toString())
    modulePath = path.join(path.dirname(modulePath), pkg.module || pkg.main)
    source = (await fs.readFile(modulePath, 'utf-8')).toString()
  } catch (error) {
    ctx.status = 404
    return
  }
  ctx.type = 'js'
  ctx.body = source
}

async function moduleRewrite(ctx, next) {
  if (!ctx.path.endsWith('.js')) {
    return next()
  }

  const path = root + ctx.path
  let content
  try {
    content = (await fs.readFile(path, "utf-8")).toString()
  } catch (error) {
    ctx.status = 404
  } 
  ctx.type = 'js'
  ctx.body = rewrite(content)
}

function rewrite(source, asSFC = false) {
  const ast = parse(source, {
    plugins: [
      'bigInt',
      'optionalChaining',
      'nullishCoalescingOperator'
    ],
    sourceType: 'module'
  }).program.body

  let s = new MagicString(source)
  ast.forEach((node) => {
    if (node.type === 'ImportDeclaration') {
      if (/^[^\.\/]/.test(node.source.value)) {
        s.overwrite(
          node.source.start,
          node.source.end,
          `"/@modules/${node.source.value}"`
        )
      }
    } else if (asSFC && node.type == 'ExportDefaultDeclaration') {
      s.overwrite(
        node.start,
        node.declaration.start,
        `let __script; 
        export default (__script = `
      )
      s.appendRight(node.end, `)`)
    }
  })
  return s.toString()
}

const cache = new Map()
async function parseSFC(
  filename,
  saveCache = false,
  ) {
  const content = await fs.readFile(filename , 'utf-8')
  const { descriptor, errors } = sfcParse(content, {
    filename
  })

  if (errors.length) {
    throw Error('compile sfc error')
  }

  const prev = cache.get(filename)
  if (saveCache) {
    cache.set(filename, descriptor)
  }
  return [descriptor, prev]
}

app.use(staticSever(root))

const server = app.listen(3000)

const wss = new WebSocketServer({ server })
const connects = new Set()
wss.on('connection', (conn) => {
  connects.add(conn)
  conn.send(JSON.stringify({type: 'connected'}))
  conn.on('close', () => {
    connects.delete(conn)
  })
})

wss.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') {
    console.info('test')
    console.error(e)
  }
})

async function createFileWatcher(root, notify) {
  const fileWatch = chokidar.watch(root, {
    ignored: [/node_modules/]
  })
  fileWatch.on('change', async (file) => {
    const resourcePath = '/' + path.relative(root, file)
    const send = (payload) => {
      console.log(`[hmr] ${JSON.stringify(payload)}`)
      notify(JSON.stringify(payload))
    }
    if (file.endsWith('.vue')) {
      const [descriptor, prevDescriptor] = await parseSFC(root + resourcePath, true)

      if (!descriptor || !prevDescriptor) {
        return
      }

      if (!isEqual(descriptor.script, prevDescriptor.script)) {
        console.info('[hmr] vue component script was chaned')
        send({
          type: 'reload',
          path: resourcePath
        })
        return
      }

      if (!isEqual(descriptor.template, prevDescriptor.template)) {
        console.info('[hmr] vue component template was chaned')
        send({
          type: 'rerender',
          path: resourcePath
        })
        return
      }

      const prevStyles = prevDescriptor.styles || []
      const nextStyles = descriptor.styles || []
      nextStyles.forEach((_, i) => {
        if (!prevStyles[i] || !isEqual(prevStyles[i], nextStyles[i])) {
          send({
            type: 'style-update',
            path: resourcePath,
            index: i
          })
        }
      })
      // "vue-style-${id}-${index}"
      prevStyles.slice(nextStyles.length).forEach((_, i) => {
        send({
          type: 'style-remove',
          path: resourcePath,
          id: `${hash(resourcePath)}-${i + nextStyles.length}`
        })
      })
    } else {
      send({
        type: 'full-reload'
      })
    }
  })
}

function isEqual(a, b) {
  if (!a || !b) return false
  if (a.content !== b.content) return false
  const keysA = Object.keys(a.attrs)
  const keysB = Object.keys(b.attrs)
  if (keysA.length !== keysB.length) {
    return false
  }
  return keysA.every((key) => a.attrs[key] === b.attrs[key])
}

await createFileWatcher(
  root,
  (payload) => connects.forEach((conn) => conn.send(payload)) 
)