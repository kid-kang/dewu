import './loadEnv.js'
import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import multer from 'multer'
import {spawn, execFileSync} from 'child_process'
import {randomUUID, timingSafeEqual} from 'crypto'
import {fileURLToPath} from 'url'
import {
  getMeta,
  getCategories,
  search,
  warmCache,
  savePairedUploads,
  savePromoUploads,
} from './dataService.js'
import {openDb} from './db.js'
import {authenticateUser, requireAuth, signUserToken} from './auth.js'
import {ensureCategoriesMigrated} from './migrateCategories.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const app = express()
const PORT = process.env.PORT || 3780
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '我爱康康的大宝贝'

const logDir = path.join(root, 'logs')
const logFile = path.join(logDir, 'log.log')
fs.mkdirSync(logDir, {recursive: true})

function writeLog(message) {
  const line = `${new Date().toISOString()} ${message}\n`
  fs.appendFile(logFile, line, (err) => {
    if (err) console.error('[log] write failed:', err)
  })
}

function redactValue(key, value) {
  if (/token|password|authorization|secret/i.test(String(key))) return '***'
  return value
}

function summarizePayload(obj) {
  if (!obj || typeof obj !== 'object') return undefined
  const out = {}
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value) && value.length > 8) {
      out[key] = `[${value.length} items]`
    } else {
      out[key] = redactValue(key, value)
    }
  }
  return out
}

function isApiRequest(req) {
  const p = req.path || ''
  return p.startsWith('/api') || p === '/pull'
}

app.set('trust proxy', true)

function getCommitId() {
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
  } catch {
    return 'unknown'
  }
}

async function metaWithCommit() {
  return {...(await getMeta(root)), commit: getCommitId()}
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 80 * 1024 * 1024,
    files: 40,
  },
  fileFilter(_req, file, cb) {
    if (/\.xlsx$/i.test(file.originalname)) cb(null, true)
    else cb(new Error('仅支持 .xlsx 文件'))
  },
})

/** @type {Map<string, object>} */
const jobs = new Map()

function checkToken(provided, expected) {
  const a = Buffer.from(String(provided ?? ''), 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function checkUploadToken(provided) {
  return checkToken(provided, UPLOAD_TOKEN)
}

app.use(cors())
app.use(express.json({limit: '2mb'}))
app.use((req, res, next) => {
  if (!isApiRequest(req)) {
    next()
    return
  }
  const start = Date.now()
  res.on('finish', () => {
    const ms = Date.now() - start
    const query = summarizePayload(req.query)
    const body = summarizePayload(req.body)
    const files = Array.isArray(req.files)
      ? req.files.map((f) => f.originalname || 'unknown')
      : undefined
    const extra = []
    if (query && Object.keys(query).length) extra.push(`query=${JSON.stringify(query)}`)
    if (body && Object.keys(body).length) extra.push(`body=${JSON.stringify(body)}`)
    if (files?.length) extra.push(`files=${JSON.stringify(files)}`)
    writeLog(
      [
        req.method,
        req.originalUrl || req.url,
        res.statusCode,
        `${ms}ms`,
        req.ip || '-',
        ...extra,
      ].join(' '),
    )
  })
  next()
})
app.use('/vendor/xlsx', express.static(path.join(root, 'node_modules/xlsx/dist'), {
  maxAge: '7d',
}))
app.use(express.static(path.join(root, 'public'), {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
  },
}))

function cleanupJobs() {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 30 * 60 * 1000) jobs.delete(id)
  }
}
setInterval(cleanupJobs, 60_000).unref()

app.post('/api/login', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '')
    if (!username || !password) {
      res.status(400).json({ok: false, error: '请输入账号和密码'})
      return
    }
    const user = await authenticateUser(root, username, password)
    if (!user) {
      res.status(401).json({ok: false, error: '账号或密码错误'})
      return
    }
    const token = signUserToken(user)
    res.json({ok: true, data: {token, username: user.username, expiresIn: '365d'}})
  } catch (err) {
    console.error(err)
    res.status(500).json({ok: false, error: String(err.message || err)})
  }
})

app.use('/api', requireAuth)

app.get('/api/meta', async (_req, res) => {
  try {
    res.json({ok: true, data: await metaWithCommit()})
  } catch (err) {
    res.status(500).json({ok: false, error: String(err.message || err)})
  }
})

app.post('/api/upload', (req, res) => {
  upload.array('files', 40)(req, res, async (err) => {
    if (err) {
      res.status(400).json({ok: false, error: String(err.message || err)})
      return
    }
    try {
      if (!checkUploadToken(req.body?.token)) {
        res.status(403).json({ok: false, error: '上传口令错误'})
        return
      }

      const files = Array.isArray(req.files) ? req.files : []
      if (!files.length) {
        res.status(400).json({ok: false, error: '请选择文件（须同时包含大店与小店成对日期）'})
        return
      }

      // busboy/multer 常把 UTF-8 文件名按 latin1 解析，这里还原中文名
      const normalized = files.map((file) => {
        const raw = file.originalname || 'unknown.xlsx'
        let name = raw
        if (!/^(大店|小店)/.test(name)) {
          const decoded = Buffer.from(name, 'latin1').toString('utf8')
          if (/^(大店|小店)/.test(decoded)) name = decoded
        }
        return {...file, originalname: name}
      })

      const batch = await savePairedUploads(root, normalized)
      res.status(batch.ok ? 200 : 400).json({
        ok: batch.ok,
        error: batch.ok ? undefined : '校验未通过或写入失败，未写入任何文件',
        data: {
          results: batch.results,
          okCount: batch.okCount,
          failCount: batch.failCount,
          meta: await metaWithCommit(),
        },
      })
    } catch (e) {
      console.error(e)
      res.status(500).json({ok: false, error: String(e.message || e)})
    }
  })
})

app.post('/api/upload-promo', (req, res) => {
  upload.array('files', 20)(req, res, async (err) => {
    if (err) {
      res.status(400).json({ok: false, error: String(err.message || err)})
      return
    }
    try {
      if (!checkUploadToken(req.body?.token)) {
        res.status(403).json({ok: false, error: '上传口令错误'})
        return
      }

      const files = Array.isArray(req.files) ? req.files : []
      if (!files.length) {
        res.status(400).json({ok: false, error: '请选择得物推 .xlsx 文件'})
        return
      }

      const batch = await savePromoUploads(root, files)
      res.status(batch.ok ? 200 : 400).json({
        ok: batch.ok,
        error: batch.ok ? undefined : '校验未通过或写入失败，未写入任何文件',
        data: {
          results: batch.results,
          okCount: batch.okCount,
          failCount: batch.failCount,
          meta: await metaWithCommit(),
        },
      })
    } catch (e) {
      console.error(e)
      res.status(500).json({ok: false, error: String(e.message || e)})
    }
  })
})

app.get('/api/categories', async (_req, res) => {
  try {
    const tree = await getCategories(root)
    res.json({ok: true, data: tree})
  } catch (err) {
    res.status(500).json({ok: false, error: String(err.message || err)})
  }
})

/** Create async search job — returns immediately, poll /api/jobs/:id */
app.post('/api/jobs', (req, res) => {
  const id = randomUUID()
  const body = req.body || {}
  const job = {
    id,
    createdAt: Date.now(),
    status: 'running',
    progress: {type: 'progress', phase: 'read', done: 0, total: 1, label: '任务已创建'},
    result: null,
    error: null,
  }
  jobs.set(id, job)
  res.json({ok: true, id})

  setImmediate(async () => {
    try {
      const result = await search(
        root,
        {
          startDate: body.startDate || null,
          endDate: body.endDate || null,
          spuid: body.spuid || '',
          sku: body.sku || '',
          categories: Array.isArray(body.categories) ? body.categories : [],
          shop: body.shop || '',
        },
        (evt) => {
          const current = jobs.get(id)
          if (current && current.status === 'running') {
            current.progress = evt
          }
        },
      )
      const current = jobs.get(id)
      if (current) {
        current.status = 'done'
        current.progress = {type: 'progress', phase: 'done', done: 1, total: 1, label: '完成'}
        current.result = result
      }
    } catch (err) {
      console.error(err)
      const current = jobs.get(id)
      if (current) {
        current.status = 'error'
        current.error = String(err.message || err)
      }
    }
  })
})

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) {
    res.status(404).json({ok: false, error: '任务不存在或已过期'})
    return
  }
  res.json({
    ok: true,
    data: {
      id: job.id,
      status: job.status,
      progress: job.progress,
      error: job.error,
      result: job.status === 'done' ? job.result : null,
    },
  })
})

app.post('/api/search', async (req, res) => {
  try {
    const body = req.body || {}
    const result = await search(root, {
      startDate: body.startDate || null,
      endDate: body.endDate || null,
      spuid: body.spuid || '',
      sku: body.sku || '',
      categories: Array.isArray(body.categories) ? body.categories : [],
      shop: body.shop || '',
    })
    res.json({ok: true, data: result})
  } catch (err) {
    console.error(err)
    res.status(500).json({ok: false, error: String(err.message || err)})
  }
})

/** 已登录即可；立即返回。脱附跑 git pull + npm i，避免 node --watch 中途重启杀掉任务 */
app.post('/pull', requireAuth, (req, res) => {
  try {
    const outFd = fs.openSync(logFile, 'a')
    // Alpine 无 bash，用 sh；date -Iseconds 也非 busybox 便携写法
    const child = spawn(
      'sh',
      [
        '-x',
        '-c',
        [
          'echo "[deploy] $(date -u +%Y-%m-%dT%H:%M:%SZ) start"',
          'git pull --ff-only',
          'npm install --registry=https://registry.npmmirror.com',
          // 仅 node_modules 变更时 --watch 不一定重启，touch 一下入口文件
          'touch server/index.js',
          'echo "[deploy] $(date -u +%Y-%m-%dT%H:%M:%SZ) done"',
        ].join(' && '),
      ],
      {
        cwd: root,
        detached: true,
        stdio: ['ignore', outFd, outFd],
        env: process.env,
      },
    )
    child.on('error', (err) => {
      console.error('[deploy] spawn error:', err)
      writeLog(`deploy spawn error: ${err.message || err}`)
    })
    if (!child.pid) {
      fs.closeSync(outFd)
      res.status(500).json({ok: false, error: '无法启动部署进程'})
      return
    }
    child.unref()
    fs.closeSync(outFd)
    console.log('[deploy] git pull + npm install queued, pid=', child.pid)
    writeLog(`deploy queued pid=${child.pid}`)
    res.json({ok: true, message: '已开始拉取并安装依赖，完成后服务会自动重载'})
  } catch (err) {
    console.error('[deploy] spawn failed:', err)
    res.status(500).json({ok: false, error: String(err.message || err)})
  }
})

app.listen(PORT, async () => {
  try {
    await openDb(root)
    const mig = await ensureCategoriesMigrated(root)
    if (mig.skipped) {
      console.log(`[migrate] 类目已就绪，共 ${mig.total} 个（跳过重复迁移）`)
    }
  } catch (err) {
    console.warn('[migrate] 数据库初始化失败:', err.message || err)
  }
  const meta = await getMeta(root)
  console.log(`Dewu search ready at http://localhost:${PORT}`)
  writeLog(`server start port=${PORT} commit=${getCommitId()}`)
  if (!meta.dbReady) {
    console.warn('数据库未就绪，请检查 DATABASE_URL 与 Postgres；可运行: npm run import:db')
  } else {
    console.log(`数据范围: ${meta.minDate} ~ ${meta.maxDate}`)
    console.log(`日期数: 大店 ${meta.fileCounts.大店} / 小店 ${meta.fileCounts.小店}`)
  }
  console.log('请用浏览器打开上面的地址（不要直接打开 index.html）')
  await warmCache(root)
})
