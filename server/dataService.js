import fs from 'fs'
import path from 'path'
import XLSX from 'xlsx'

const SHOPS = {
  大店: '大店',
  小店: '小店',
}

const CACHE_VERSION = 1
const READ_CONCURRENCY = 2

/** @type {Map<string, { mtimeMs: number, rows: object[] }>} */
const memoryCache = new Map()

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

function shopDir(root, shop) {
  return path.join(root, shop)
}

function cacheDir(root) {
  return path.join(root, '.cache')
}

function cachePathFor(root, shop, date) {
  return path.join(cacheDir(root), shop, `${date}.json`)
}

function promoDir(root) {
  return path.join(root, '得物推数据')
}

function promoCachePath(root, fileName) {
  return path.join(cacheDir(root), '得物推', `${fileName}.json`)
}

const PROMO_CACHE_VERSION = 1

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** Filename like 2026.4.1-2026.7.14.xlsx */
export function parsePromoFilename(name) {
  const base = path.basename(String(name || ''))
  const m = base.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})-(\d{4})\.(\d{1,2})\.(\d{1,2})\.xlsx$/i)
  if (!m) return null
  return {
    fileName: base,
    start: `${m[1]}${pad2(m[2])}${pad2(m[3])}`,
    end: `${m[4]}${pad2(m[5])}${pad2(m[6])}`,
    year: Number(m[1]),
  }
}

function listPromoFiles(root) {
  const dir = promoDir(root)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .map((name) => parsePromoFilename(name))
    .filter(Boolean)
    .map((info) => ({
      ...info,
      filePath: path.join(dir, info.fileName),
    }))
    .sort((a, b) => a.start.localeCompare(b.start))
}

function mdToYmd(md, year) {
  const m = String(md ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})$/)
  if (!m) return null
  const ymd = `${year}${pad2(m[1])}${pad2(m[2])}`
  return isValidYmd(ymd) ? ymd : null
}

/** Fix broken Excel dimension (often A1:AC2 while data has 20万+ rows). */
function expandSheetRef(sheet) {
  let maxR = 0
  let maxC = 0
  for (const key in sheet) {
    if (key.charCodeAt(0) === 33) continue
    let i = 0
    while (i < key.length) {
      const code = key.charCodeAt(i)
      if (code >= 48 && code <= 57) break
      i += 1
    }
    if (i === 0 || i >= key.length) continue
    const rowNum = Number(key.slice(i))
    if (!Number.isFinite(rowNum)) continue
    if (rowNum > maxR) maxR = rowNum
    // rough col from letters
    let col = 0
    for (let j = 0; j < i; j++) {
      const c = key.charCodeAt(j)
      if (c >= 65 && c <= 90) col = col * 26 + (c - 64)
      else if (c >= 97 && c <= 122) col = col * 26 + (c - 96)
    }
    if (col > maxC) maxC = col
  }
  if (maxR < 1) return
  sheet['!ref'] = XLSX.utils.encode_range({
    s: {r: 0, c: 0},
    e: {r: maxR - 1, c: Math.max(maxC - 1, 0)},
  })
}

/**
 * Compact promo rows: [ymd, spuid, cost, directPay]
 * @returns {Array<[string, string, number, number]>}
 */
function parsePromoXlsx(filePath, year) {
  const wb = XLSX.readFile(filePath, {cellDates: false, raw: false})
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) return []
  expandSheetRef(sheet)

  let maxR = 0
  const decoded = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null
  if (decoded) maxR = decoded.e.r + 1

  /** @type {Array<[string, string, number, number]>} */
  const rows = []
  // Row1 notice, Row2 header, data from Row3
  for (let excelRow = 3; excelRow <= maxR; excelRow++) {
    const md = sheet[`A${excelRow}`]?.v
    const spuidRaw = sheet[`G${excelRow}`]?.v
    if (md == null && spuidRaw == null) continue
    const ymd = mdToYmd(md, year)
    const spuid = String(spuidRaw ?? '').trim()
    if (!ymd || !spuid) continue
    const cost = parseNumber(sheet[`H${excelRow}`]?.v)
    const directPay = parseNumber(sheet[`P${excelRow}`]?.v)
    rows.push([ymd, spuid, cost, directPay])
  }
  return rows
}

async function loadPromoFileRows(root, fileInfo) {
  const {filePath, fileName, year} = fileInfo
  const stat = await fs.promises.stat(filePath)
  const memKey = `promo:${filePath}`
  const cached = memoryCache.get(memKey)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.rows

  const cp = promoCachePath(root, fileName)
  try {
    if (fs.existsSync(cp)) {
      const raw = await fs.promises.readFile(cp, 'utf8')
      const data = JSON.parse(raw)
      if (data.v === PROMO_CACHE_VERSION && data.mtimeMs === stat.mtimeMs) {
        memoryCache.set(memKey, {mtimeMs: stat.mtimeMs, rows: data.rows || []})
        return data.rows || []
      }
    }
  } catch {
    /* fall through */
  }

  await yieldEventLoop()
  const rows = parsePromoXlsx(filePath, year)
  try {
    fs.mkdirSync(path.dirname(cp), {recursive: true})
    fs.writeFileSync(cp, JSON.stringify({v: PROMO_CACHE_VERSION, mtimeMs: stat.mtimeMs, rows}))
  } catch (err) {
    console.warn('promo cache write failed:', err.message)
  }
  memoryCache.set(memKey, {mtimeMs: stat.mtimeMs, rows})
  await yieldEventLoop()
  return rows
}

/**
 * Aggregate 得物推数据 by SPUID within [startDate, endDate].
 * @returns {Map<string, { recommendPayAmount: number, recommendCost: number, recommendRoi: number|null }>}
 */
export async function aggregatePromoBySpuid(root, startDate, endDate, onProgress) {
  /** @type {Map<string, { recommendPayAmount: number, recommendCost: number, recommendRoi: number|null }>} */
  const map = new Map()
  if (!startDate || !endDate) return map

  const files = listPromoFiles(root).filter((f) => f.start <= endDate && f.end >= startDate)
  if (!files.length) return map

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (onProgress) {
      await onProgress({
        type: 'progress',
        phase: 'promo',
        done: i,
        total: files.length,
        label: `得物推 ${file.fileName}`,
      })
    }
    const rows = await loadPromoFileRows(root, file)
    for (const [ymd, spuid, cost, directPay] of rows) {
      if (ymd < startDate || ymd > endDate) continue
      let bucket = map.get(spuid)
      if (!bucket) {
        bucket = {recommendPayAmount: 0, recommendCost: 0, recommendRoi: null}
        map.set(spuid, bucket)
      }
      bucket.recommendPayAmount += directPay
      bucket.recommendCost += cost
    }
  }

  for (const bucket of map.values()) {
    bucket.recommendPayAmount = round2(bucket.recommendPayAmount)
    bucket.recommendCost = round2(bucket.recommendCost)
    bucket.recommendRoi =
      bucket.recommendCost === 0
        ? null
        : round2(bucket.recommendPayAmount / bucket.recommendCost)
  }

  if (onProgress) {
    await onProgress({
      type: 'progress',
      phase: 'promo',
      done: files.length,
      total: files.length,
      label: '得物推汇总完成',
    })
  }
  return map
}

function attachPromoMetrics(detailRows, promoMap) {
  return detailRows.map((row) => {
    const promo = promoMap.get(String(row.spuid))
    return {
      ...row,
      recommendPayAmount: promo ? promo.recommendPayAmount : 0,
      recommendCost: promo ? promo.recommendCost : 0,
      recommendRoi: promo ? promo.recommendRoi : null,
    }
  })
}


function parseDateFromFilename(name) {
  const base = path.basename(String(name || ''))
  const m = base.match(/^(\d{8})\.xlsx$/i)
  return m ? m[1] : null
}

function isValidYmd(ymd) {
  if (!/^\d{8}$/.test(ymd)) return false
  const y = Number(ymd.slice(0, 4))
  const m = Number(ymd.slice(4, 6))
  const d = Number(ymd.slice(6, 8))
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

/** Upload name: 大店20260714.xlsx / 小店20260714.xlsx */
export function parseUploadFilename(name) {
  const base = path.basename(String(name || ''))
  const m = base.match(/^(大店|小店)(\d{8})\.xlsx$/i)
  if (!m) return null
  const shop = m[1]
  const date = m[2]
  if (!isValidYmd(date)) return null
  return {shop, date}
}

export function listShopDates(root, shop) {
  const dir = shopDir(root, shop)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .map((f) => parseDateFromFilename(f))
    .filter(Boolean)
    .sort()
}

export function shopDateExists(root, shop, date) {
  if (!SHOPS[shop] || !date) return false
  return fs.existsSync(path.join(shopDir(root, shop), `${date}.xlsx`))
}

/**
 * Save buffer as YYYYMMDD.xlsx into shop folder.
 * @returns {{ ok: boolean, error?: string, date?: string, shop?: string, rowCount?: number }}
 */
export function saveUploadedShopFile(root, shop, date, buffer) {
  if (!SHOPS[shop]) {
    return {ok: false, error: '店铺无效'}
  }
  if (!isValidYmd(date)) {
    return {ok: false, error: `日期无效：${date}`}
  }

  const dir = shopDir(root, shop)
  fs.mkdirSync(dir, {recursive: true})
  const dest = path.join(dir, `${date}.xlsx`)
  if (fs.existsSync(dest)) {
    return {ok: false, error: `${shop} 已存在 ${date}.xlsx`}
  }

  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, buffer)
    const rows = parseXlsxRows(tmp, shop, date)
    fs.renameSync(tmp, dest)
    const stat = fs.statSync(dest)
    writeDiskCache(root, shop, date, stat.mtimeMs, rows)
    memoryCache.set(dest, {mtimeMs: stat.mtimeMs, rows})
    return {ok: true, shop, date, rowCount: rows.length}
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest)
    } catch {
      /* ignore */
    }
    return {ok: false, error: `文件无法解析：${err.message || err}`}
  }
}

function removeShopDateFile(root, shop, date) {
  const dest = path.join(shopDir(root, shop), `${date}.xlsx`)
  const cache = cachePathFor(root, shop, date)
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest)
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(cache)) fs.unlinkSync(cache)
  } catch {
    /* ignore */
  }
  memoryCache.delete(dest)
}

/**
 * Validate paired uploads then save. Filenames must be 大店YYYYMMDD.xlsx / 小店YYYYMMDD.xlsx.
 * Each date must include both shops; no partial write on failure.
 * @param {{ originalname: string, buffer: Buffer }[]} files
 */
export function savePairedUploads(root, files) {
  /** @type {{ name: string, ok: boolean, shop?: string, date?: string, rowCount?: number, error?: string }[]} */
  const results = []
  /** @type {{ name: string, shop: string, date: string, buffer: Buffer }[]} */
  const prepared = []
  /** @type {Map<string, { 大店?: string, 小店?: string }>} */
  const byDate = new Map()
  /** @type {Map<string, string>} key shop|date -> name */
  const seenKey = new Map()

  for (const file of files) {
    const name = file.originalname || 'unknown.xlsx'
    if (!/\.xlsx$/i.test(name)) {
      results.push({name, ok: false, error: '仅支持 .xlsx'})
      continue
    }
    const parsed = parseUploadFilename(name)
    if (!parsed) {
      results.push({name, ok: false, error: '命名须为 大店YYYYMMDD.xlsx 或 小店YYYYMMDD.xlsx'})
      continue
    }
    const key = `${parsed.shop}|${parsed.date}`
    if (seenKey.has(key)) {
      results.push({name, ok: false, error: `与 ${seenKey.get(key)} 重复`, shop: parsed.shop, date: parsed.date})
      continue
    }
    if (shopDateExists(root, parsed.shop, parsed.date)) {
      results.push({name, ok: false, error: `${parsed.shop} 已存在 ${parsed.date}.xlsx`, shop: parsed.shop, date: parsed.date})
      continue
    }
    seenKey.set(key, name)
    if (!byDate.has(parsed.date)) byDate.set(parsed.date, {})
    byDate.get(parsed.date)[parsed.shop] = name
    prepared.push({name, shop: parsed.shop, date: parsed.date, buffer: file.buffer})
    results.push({name, ok: true, shop: parsed.shop, date: parsed.date})
  }

  // Pair check: every date in this batch must have both shops
  const pairErrors = new Map()
  for (const [date, shops] of byDate) {
    if (!shops['大店'] || !shops['小店']) {
      const missing = !shops['大店'] ? '大店' : '小店'
      const msg = `${date} 缺少${missing}文件，须成对上传`
      if (shops['大店']) pairErrors.set(shops['大店'], msg)
      if (shops['小店']) pairErrors.set(shops['小店'], msg)
    }
  }

  if (pairErrors.size || results.some((r) => !r.ok)) {
    return {
      ok: false,
      results: results.map((r) => {
        if (!r.ok) return r
        if (pairErrors.has(r.name)) {
          return {...r, ok: false, error: pairErrors.get(r.name)}
        }
        // Valid file but batch blocked by other errors
        const batchMsg = pairErrors.size
          ? '批次未成对，已取消写入'
          : '同批次存在无效文件，已取消写入'
        return {...r, ok: false, error: batchMsg}
      }),
      okCount: 0,
      failCount: results.length,
      saved: false,
    }
  }

  /** @type {{ shop: string, date: string }[]} */
  const written = []
  for (const item of prepared) {
    const saved = saveUploadedShopFile(root, item.shop, item.date, item.buffer)
    if (!saved.ok) {
      for (const w of written) removeShopDateFile(root, w.shop, w.date)
      return {
        ok: false,
        results: results.map((r) => {
          if (r.name === item.name) {
            return {...r, ok: false, error: saved.error || '写入失败'}
          }
          if (written.some((w) => `${w.shop}${w.date}` === `${r.shop}${r.date}`)) {
            return {...r, ok: false, error: '同批次写入失败，已回滚'}
          }
          return {...r, ok: false, error: '同批次写入失败，已取消'}
        }),
        okCount: 0,
        failCount: results.length,
        saved: false,
      }
    }
    written.push({shop: item.shop, date: item.date})
    const idx = results.findIndex((r) => r.name === item.name)
    if (idx >= 0) {
      results[idx] = {
        ...results[idx],
        ok: true,
        rowCount: saved.rowCount || 0,
      }
    }
  }

  return {
    ok: true,
    results,
    okCount: results.length,
    failCount: 0,
    saved: true,
  }
}


/** Extract first number from mixed cell values like "79430.0元" or "3390 (指数)" */
export function parseNumber(value) {
  if (value == null || value === '' || value === '-') return 0
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const s = String(value).replace(/,/g, '')
  const m = s.match(/-?\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : 0
}

function normalizeRow(raw, shop, date) {
  return {
    date,
    shop,
    spuid: String(raw['SPUID'] ?? '').trim(),
    sku: String(raw['商品货号'] ?? '').trim(),
    category: String(raw['类目名称'] ?? '').trim(),
    payAmount: parseNumber(raw['支付金额']),
    detailVisitors: parseNumber(raw['商详访问人数']),
    favorites: parseNumber(raw['收藏用户数']),
    payUsers: parseNumber(raw['支付用户数']),
  }
}

function rowsToCompact(rows) {
  return rows.map((r) => [r.spuid, r.sku, r.category, r.payAmount, r.detailVisitors, r.favorites, r.payUsers])
}

function compactToRows(compact, shop, date) {
  return compact.map(([spuid, sku, category, payAmount, detailVisitors, favorites, payUsers]) => ({
    date,
    shop,
    spuid: String(spuid),
    sku: String(sku ?? ''),
    category: String(category ?? ''),
    payAmount: Number(payAmount) || 0,
    detailVisitors: Number(detailVisitors) || 0,
    favorites: Number(favorites) || 0,
    payUsers: Number(payUsers) || 0,
  }))
}

function parseXlsxRows(filePath, shop, date) {
  const wb = XLSX.readFile(filePath, {
    cellDates: false,
    raw: false,
  })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const json = XLSX.utils.sheet_to_json(sheet, {defval: null})
  return json
    .map((r) => normalizeRow(r, shop, date))
    .filter((r) => r.spuid)
}

function ensureCacheDir(root, shop) {
  const dir = path.join(cacheDir(root), shop)
  fs.mkdirSync(dir, {recursive: true})
  return dir
}

function writeDiskCache(root, shop, date, mtimeMs, rows) {
  try {
    ensureCacheDir(root, shop)
    const payload = JSON.stringify({
      v: CACHE_VERSION,
      mtimeMs,
      rows: rowsToCompact(rows),
    })
    fs.writeFileSync(cachePathFor(root, shop, date), payload)
  } catch (err) {
    console.warn('cache write failed:', err.message)
  }
}

async function readSheetRows(root, filePath, shop, date) {
  const stat = await fs.promises.stat(filePath)
  const memKey = filePath
  const cached = memoryCache.get(memKey)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.rows

  let rows = null
  const cp = cachePathFor(root, shop, date)
  try {
    if (fs.existsSync(cp)) {
      const raw = await fs.promises.readFile(cp, 'utf8')
      const data = JSON.parse(raw)
      if (data.v === CACHE_VERSION && data.mtimeMs === stat.mtimeMs) {
        rows = compactToRows(data.rows || [], shop, date)
      }
    }
  } catch {
    rows = null
  }

  if (!rows) {
    // yield before heavy sync parse so progress socket can flush
    await yieldEventLoop()
    rows = parseXlsxRows(filePath, shop, date)
    writeDiskCache(root, shop, date, stat.mtimeMs, rows)
  }

  memoryCache.set(memKey, {mtimeMs: stat.mtimeMs, rows})
  await yieldEventLoop()
  return rows
}

export function listAvailableDates(root, shops = Object.keys(SHOPS)) {
  const set = new Set()
  for (const shop of shops) {
    const dir = shopDir(root, shop)
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      const d = parseDateFromFilename(name)
      if (d) set.add(d)
    }
  }
  return [...set].sort()
}

function datesInRange(allDates, start, end) {
  return allDates.filter((d) => (!start || d >= start) && (!end || d <= end))
}

function listJobs(root, shops, start, end) {
  const allDates = listAvailableDates(root, shops)
  const dates = datesInRange(allDates, start, end)
  /** @type {{ shop: string, date: string, filePath: string }[]} */
  const jobs = []

  for (const shop of shops) {
    const dir = shopDir(root, shop)
    if (!fs.existsSync(dir)) continue
    for (const date of dates) {
      const filePath = path.join(dir, `${date}.xlsx`)
      if (!fs.existsSync(filePath)) continue
      jobs.push({shop, date, filePath})
    }
  }
  return jobs
}

async function mapPool(items, concurrency, mapper, onProgress) {
  const results = new Array(items.length)
  let next = 0
  let done = 0

  async function worker() {
    while (next < items.length) {
      const i = next++
      const item = items[i]
      results[i] = await mapper(item, i)
      done += 1
      if (onProgress) await onProgress(done, items.length, item)
      await yieldEventLoop()
    }
  }

  const workers = Array.from({length: Math.min(concurrency, Math.max(items.length, 1))}, () => worker())
  await Promise.all(workers)
  return results
}

/**
 * @param {(done:number,total:number,info?:object)=>void|Promise<void>} [onProgress]
 */
export async function loadRowsForRange(root, shops, start, end, onProgress) {
  const jobs = listJobs(root, shops, start, end)
  if (!jobs.length) {
    if (onProgress) await onProgress(0, 0)
    return []
  }

  if (onProgress) await onProgress(0, jobs.length, {shop: '', date: '', starting: true})

  const chunks = await mapPool(
    jobs,
    READ_CONCURRENCY,
    async (job) => readSheetRows(root, job.filePath, job.shop, job.date),
    async (done, total, job) => {
      if (onProgress) await onProgress(done, total, {shop: job.shop, date: job.date})
    },
  )

  const rows = []
  for (const chunk of chunks) rows.push(...chunk)
  return rows
}

function categoryPath(category) {
  return category.split('-').map((s) => s.trim()).filter(Boolean)
}

export function buildCategoryTree(rows) {
  const root = {}
  for (const row of rows) {
    if (!row.category) continue
    const parts = categoryPath(row.category)
    let node = root
    for (const part of parts) {
      if (!node[part]) node[part] = {}
      node = node[part]
    }
  }

  function toList(obj, prefix = []) {
    return Object.keys(obj)
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))
      .map((label) => {
        const value = [...prefix, label].join('-')
        const children = toList(obj[label], [...prefix, label])
        return children.length
          ? {label, value, children}
          : {label, value}
      })
  }

  return toList(root)
}

function matchesCategory(rowCategory, selected) {
  if (!selected?.length) return true
  return selected.some((sel) => rowCategory === sel || rowCategory.startsWith(`${sel}-`))
}

function filterRows(rows, {spuid, sku, categories}) {
  const spuidQ = spuid ? String(spuid).trim() : ''
  const skuQ = sku ? String(sku).trim() : ''

  return rows.filter((r) => {
    if (spuidQ && !r.spuid.includes(spuidQ)) return false
    if (skuQ && !r.sku.includes(skuQ)) return false
    if (!matchesCategory(r.category, categories)) return false
    return true
  })
}

function emptyShopMetrics() {
  return {payAmount: 0, detailVisitors: 0, favorites: 0, payUsers: 0}
}

export function summarize(rows) {
  const big = emptyShopMetrics()
  const small = emptyShopMetrics()

  for (const r of rows) {
    const bucket = r.shop === '大店' ? big : small
    bucket.payAmount += r.payAmount
    bucket.detailVisitors += r.detailVisitors
    bucket.favorites += r.favorites
    bucket.payUsers += r.payUsers
  }

  return {
    payAmount: {
      大店: round2(big.payAmount),
      小店: round2(small.payAmount),
      总和: round2(big.payAmount + small.payAmount),
    },
    detailVisitors: {
      大店: round2(big.detailVisitors),
      小店: round2(small.detailVisitors),
    },
    favorites: {
      大店: round2(big.favorites),
      小店: round2(small.favorites),
    },
    payUsers: {
      大店: round2(big.payUsers),
      小店: round2(small.payUsers),
      总和: round2(big.payUsers + small.payUsers),
    },
  }
}

function round2(n) {
  return Math.round(n * 100) / 100
}

function ymdToDate(ymd) {
  const y = Number(ymd.slice(0, 4))
  const m = Number(ymd.slice(4, 6)) - 1
  const d = Number(ymd.slice(6, 8))
  return new Date(y, m, d)
}

function dateToYmd(dt) {
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const d = String(dt.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function addDays(dt, n) {
  const x = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate())
  x.setDate(x.getDate() + n)
  return x
}

function addYears(dt, n) {
  const x = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate())
  const day = x.getDate()
  x.setFullYear(x.getFullYear() + n)
  // 处理 2/29 等跨年落点
  if (x.getDate() !== day) x.setDate(0)
  return x
}

/** @returns {'day'|'week'|'month'|null} */
export function detectSearchPeriod(startDate, endDate) {
  if (!startDate || !endDate) return null
  if (startDate === endDate) return 'day'

  const s = ymdToDate(startDate)
  const e = ymdToDate(endDate)
  const diff = Math.round((e.getTime() - s.getTime()) / 86400000)

  // 周一到周日
  if (diff === 6 && s.getDay() === 1 && e.getDay() === 0) return 'week'

  // 整月：当月 1 号到月末
  const last = new Date(s.getFullYear(), s.getMonth() + 1, 0).getDate()
  if (
    s.getDate() === 1
    && e.getDate() === last
    && s.getFullYear() === e.getFullYear()
    && s.getMonth() === e.getMonth()
  ) {
    return 'month'
  }

  return null
}

export function getCompareRanges(startDate, endDate, type) {
  const s = ymdToDate(startDate)
  const e = ymdToDate(endDate)

  const yoy = {
    startDate: dateToYmd(addYears(s, -1)),
    endDate: dateToYmd(addYears(e, -1)),
  }

  let pop
  if (type === 'day') {
    const p = addDays(s, -1)
    pop = {startDate: dateToYmd(p), endDate: dateToYmd(p)}
  } else if (type === 'week') {
    pop = {
      startDate: dateToYmd(addDays(s, -7)),
      endDate: dateToYmd(addDays(e, -7)),
    }
  } else if (type === 'month') {
    const prevLast = new Date(s.getFullYear(), s.getMonth(), 0)
    const prevFirst = new Date(prevLast.getFullYear(), prevLast.getMonth(), 1)
    pop = {
      startDate: dateToYmd(prevFirst),
      endDate: dateToYmd(prevLast),
    }
  } else {
    pop = null
  }

  return {yoy, pop}
}

function calcChangeRate(current, previous) {
  if (previous == null || Number.isNaN(Number(previous))) return null
  const curr = Number(current) || 0
  const prev = Number(previous)
  if (prev === 0) return curr === 0 ? 0 : null
  return round2(((curr - prev) / Math.abs(prev)) * 100)
}

function rowsToSpuidMap(rows) {
  const map = new Map()
  for (const row of rows) map.set(String(row.spuid), row)
  return map
}

function attachRowCompare(rows, yoyRows, popRows) {
  const yoyMap = rowsToSpuidMap(yoyRows || [])
  const popMap = rowsToSpuidMap(popRows || [])
  const keys = ['payAmount', 'detailVisitors', 'favorites', 'payUsers']

  return rows.map((row) => {
    const yoy = yoyMap.get(String(row.spuid))
    const pop = popMap.get(String(row.spuid))
    const next = {...row, hasCompare: true}
    for (const key of keys) {
      next[`${key}Pop`] = pop ? calcChangeRate(row[key], pop[key]) : null
      next[`${key}Yoy`] = yoy ? calcChangeRate(row[key], yoy[key]) : null
    }
    return next
  })
}

async function summarizeFilteredRange(root, shops, startDate, endDate, filters) {
  const raw = await loadRowsForRange(root, shops, startDate, endDate)
  const filtered = filterRows(raw, filters)
  return {
    summary: summarize(filtered),
    rows: mergeDetailRows(filtered),
    matchedRawRows: filtered.length,
    startDate,
    endDate,
  }
}

export function mergeDetailRows(rows) {
  /** @type {Map<string, object>} */
  const map = new Map()

  for (const r of rows) {
    let item = map.get(r.spuid)
    if (!item) {
      item = {
        spuid: r.spuid,
        sku: r.sku,
        category: r.category,
        payAmount: 0,
        detailVisitors: 0,
        favorites: 0,
        payUsers: 0,
        _skuFromBig: false,
        _catFromBig: false,
      }
      map.set(r.spuid, item)
    }

    item.payAmount += r.payAmount
    item.payUsers += r.payUsers

    if (r.shop === '大店') {
      item.detailVisitors += r.detailVisitors
      item.favorites += r.favorites
      if (!item._skuFromBig && r.sku) {
        item.sku = r.sku
        item._skuFromBig = true
      }
      if (!item._catFromBig && r.category) {
        item.category = r.category
        item._catFromBig = true
      }
    } else {
      if (!item.sku && r.sku) item.sku = r.sku
      if (!item.category && r.category) item.category = r.category
    }
  }

  return [...map.values()]
    .map((item) => ({
      spuid: item.spuid,
      sku: item.sku,
      category: item.category,
      payAmount: round2(item.payAmount),
      detailVisitors: round2(item.detailVisitors),
      favorites: round2(item.favorites),
      payUsers: round2(item.payUsers),
    }))
    .sort((a, b) => b.payAmount - a.payAmount)
}

export function getMeta(root) {
  const dates = listAvailableDates(root)
  const bigDates = listShopDates(root, '大店')
  const smallDates = listShopDates(root, '小店')
  return {
    shops: Object.keys(SHOPS),
    dates,
    minDate: dates[0] || null,
    maxDate: dates[dates.length - 1] || null,
    fileCounts: {
      大店: bigDates.length,
      小店: smallDates.length,
    },
    fileDates: {
      大店: bigDates,
      小店: smallDates,
    },
  }
}

export async function getCategories(root, {startDate, endDate, shop} = {}, onProgress) {
  const shops = shop && SHOPS[shop] ? [shop] : Object.keys(SHOPS)
  const rows = await loadRowsForRange(root, shops, startDate || null, endDate || null, onProgress)
  return buildCategoryTree(rows)
}

/**
 * @param {(evt:{type:string,done?:number,total?:number,phase?:string,label?:string})=>void} [onProgress]
 */
export async function search(root, query, onProgress) {
  const {
    startDate,
    endDate,
    spuid = '',
    sku = '',
    categories = [],
    shop = '',
  } = query

  const shops = shop && SHOPS[shop] ? [shop] : Object.keys(SHOPS)
  const filters = {spuid, sku, categories}

  const raw = await loadRowsForRange(root, shops, startDate || null, endDate || null, async (done, total, info) => {
    if (onProgress) {
      await onProgress({
        type: 'progress',
        phase: 'read',
        done,
        total,
        label: info?.starting
          ? `准备读取 ${total} 个文件`
          : info
            ? `${info.shop} ${info.date}`
            : '',
      })
    }
  })

  if (onProgress) {
    await onProgress({type: 'progress', phase: 'aggregate', done: 1, total: 1, label: '汇总中'})
  }

  const filtered = filterRows(raw, filters)
  const rows = mergeDetailRows(filtered)
  const summary = summarize(filtered)

  const periodType = detectSearchPeriod(startDate, endDate)
  let compare = {
    type: periodType,
    label: periodType === 'day' ? '单日' : periodType === 'week' ? '周' : periodType === 'month' ? '月' : null,
    yoy: null,
    pop: null,
  }

  if (periodType && startDate && endDate) {
    if (onProgress) {
      await onProgress({type: 'progress', phase: 'compare', done: 0, total: 2, label: '计算同比环比'})
    }
    const ranges = getCompareRanges(startDate, endDate, periodType)
    try {
      compare.yoy = await summarizeFilteredRange(
        root,
        shops,
        ranges.yoy.startDate,
        ranges.yoy.endDate,
        filters,
      )
    } catch (err) {
      console.warn('同比汇总失败:', err.message)
      compare.yoy = {summary: null, rows: [], startDate: ranges.yoy.startDate, endDate: ranges.yoy.endDate, error: String(err.message || err)}
    }
    if (onProgress) {
      await onProgress({type: 'progress', phase: 'compare', done: 1, total: 2, label: '计算环比'})
    }
    try {
      compare.pop = await summarizeFilteredRange(
        root,
        shops,
        ranges.pop.startDate,
        ranges.pop.endDate,
        filters,
      )
    } catch (err) {
      console.warn('环比汇总失败:', err.message)
      compare.pop = {summary: null, rows: [], startDate: ranges.pop.startDate, endDate: ranges.pop.endDate, error: String(err.message || err)}
    }
  }

  let detailRows = rows
  if (periodType) {
    detailRows = attachRowCompare(
      rows,
      compare.yoy?.rows || [],
      compare.pop?.rows || [],
    )
  }

  if (onProgress) {
    await onProgress({type: 'progress', phase: 'promo', done: 0, total: 1, label: '汇总得物推数据'})
  }
  try {
    const promoMap = await aggregatePromoBySpuid(root, startDate || null, endDate || null, onProgress)
    detailRows = attachPromoMetrics(detailRows, promoMap)
  } catch (err) {
    console.warn('得物推汇总失败:', err.message)
    detailRows = attachPromoMetrics(detailRows, new Map())
  }

  // 对比明细已合并进主表，响应里不再回传对比期整表
  if (compare.yoy) {
    const {rows: _yoyRows, ...yoyRest} = compare.yoy
    compare.yoy = yoyRest
  }
  if (compare.pop) {
    const {rows: _popRows, ...popRest} = compare.pop
    compare.pop = popRest
  }

  return {
    summary,
    rows: detailRows,
    compare,
    meta: {
      matchedRawRows: filtered.length,
      matchedSpus: detailRows.length,
      shops,
      startDate: startDate || null,
      endDate: endDate || null,
      periodType,
    },
  }
}

/** Warm JSON cache in background so later searches stay fast */
export function warmCache(root, {recentDays = 45, concurrency = 4} = {}) {
  const dates = listAvailableDates(root)
  const recent = dates.slice(-recentDays)
  const jobs = listJobs(root, Object.keys(SHOPS), recent[0] || null, recent[recent.length - 1] || null)

  const total = jobs.length
  console.log(`缓存预热: 最近 ${recent.length} 天，共 ${total} 个文件`);

  (async () => {
    await mapPool(
      jobs,
      concurrency,
      async (job) => {
        await readSheetRows(root, job.filePath, job.shop, job.date)
      },
      (done) => {
        if (done === total || done % 20 === 0) {
          console.log(`缓存预热进度 ${done}/${total}`)
        }
      },
    )
    console.log('缓存预热完成（近期数据）')
  })().catch((err) => console.warn('缓存预热失败:', err.message))
}
