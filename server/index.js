import express from 'express'
import cors from 'cors'
import path from 'path'
import multer from 'multer'
import {randomUUID} from 'crypto'
import {fileURLToPath} from 'url'
import {
  getMeta,
  getCategories,
  search,
  warmCache,
  savePairedUploads,
} from './dataService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const app = express()
const PORT = process.env.PORT || 3780

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

app.use(cors())
app.use(express.json({limit: '2mb'}))
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

app.get('/api/meta', (_req, res) => {
  try {
    res.json({ok: true, data: getMeta(root)})
  } catch (err) {
    res.status(500).json({ok: false, error: String(err.message || err)})
  }
})

app.post('/api/upload', (req, res) => {
  upload.array('files', 40)(req, res, (err) => {
    if (err) {
      res.status(400).json({ok: false, error: String(err.message || err)})
      return
    }
    try {
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

      const batch = savePairedUploads(root, normalized)
      res.status(batch.ok ? 200 : 400).json({
        ok: batch.ok,
        error: batch.ok ? undefined : '校验未通过或写入失败，未写入任何文件',
        data: {
          results: batch.results,
          okCount: batch.okCount,
          failCount: batch.failCount,
          meta: getMeta(root),
        },
      })
    } catch (e) {
      console.error(e)
      res.status(500).json({ok: false, error: String(e.message || e)})
    }
  })
})

app.get('/api/categories', async (req, res) => {
  try {
    const {startDate, endDate, shop} = req.query
    const tree = await getCategories(root, {
      startDate: startDate || null,
      endDate: endDate || null,
      shop: shop || '',
    })
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

app.listen(PORT, () => {
  const meta = getMeta(root)
  console.log(`Dewu search ready at http://localhost:${PORT}`)
  console.log(`数据范围: ${meta.minDate} ~ ${meta.maxDate}`)
  console.log(`文件数: 大店 ${meta.fileCounts.大店} / 小店 ${meta.fileCounts.小店}`)
  console.log('请用浏览器打开上面的地址（不要直接打开 index.html）')
  warmCache(root, {recentDays: 90, concurrency: 4})
})
