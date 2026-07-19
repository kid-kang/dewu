import fs from 'fs'
import path from 'path'
import XLSX from 'xlsx'
import {
  openDb,
  dbExists,
  upsertShopDay,
  deleteShopDay,
  upsertPromoRows,
  deletePromoRange,
  promoRangeHasData,
  setMetaFile,
  deleteMetaFile,
  queryShopRows,
  queryPromoAgg,
  listShopDatesFromDb,
  listAvailableDatesFromDb,
  getMetaFromDb,
  listCategoryNames,
  upsertCategories,
} from './db.js'

const SHOPS = {
  大店: '大店',
  小店: '小店',
}

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

function shopDir(root, shop) {
  return path.join(root, shop)
}

function promoDir(root) {
  return path.join(root, '得物推数据')
}

async function requireDb(root) {
  const ready = await dbExists(root)
  if (!ready) {
    throw new Error('数据库未就绪，请检查 DATABASE_URL 与 Postgres 服务')
  }
  return await openDb(root)
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/**
 * Filename like 2026.4.1-2026.7.14.xlsx (range) or 2026.7.14.xlsx / 2026.7.14-2026.7.14.xlsx (single day).
 * @returns {{ fileName: string, start: string, end: string, year: number } | null}
 */
export function parsePromoFilename(name) {
  const base = path.basename(String(name || ''))
  const range = base.match(
    /^(\d{4})\.(\d{1,2})\.(\d{1,2})-(\d{4})\.(\d{1,2})\.(\d{1,2})\.xlsx$/i,
  )
  if (range) {
    const start = `${range[1]}${pad2(range[2])}${pad2(range[3])}`
    const end = `${range[4]}${pad2(range[5])}${pad2(range[6])}`
    if (!isValidYmd(start) || !isValidYmd(end) || start > end) return null
    return {
      fileName: base,
      start,
      end,
      year: Number(range[1]),
    }
  }
  const single = base.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})\.xlsx$/i)
  if (single) {
    const ymd = `${single[1]}${pad2(single[2])}${pad2(single[3])}`
    if (!isValidYmd(ymd)) return null
    return {
      fileName: base,
      start: ymd,
      end: ymd,
      year: Number(single[1]),
    }
  }
  return null
}

export function listPromoFiles(root) {
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
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
}

/**
 * Find existing promo coverage that conflicts with [start, end].
 * @returns {{ fileName?: string, start: string, end: string, reason: string } | null}
 */
export async function findPromoConflict(root, start, end, {ignoreFileName = null} = {}) {
  for (const f of listPromoFiles(root)) {
    if (ignoreFileName && f.fileName === ignoreFileName) continue
    if (rangesOverlap(start, end, f.start, f.end)) {
      return {
        fileName: f.fileName,
        start: f.start,
        end: f.end,
        reason: `与已有文件 ${f.fileName}（${f.start}~${f.end}）日期重叠`,
      }
    }
  }
  if (await dbExists(root) && await promoRangeHasData(await openDb(root), start, end)) {
    return {
      start,
      end,
      reason: `数据库中已存在 ${start}~${end} 区间的得物推数据`,
    }
  }
  return null
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
 * Compact promo rows: [ymd, spuid, cost, directPay, impressions, clicks, detailVisits]
 * @returns {Array<[string, string, number, number, number, number, number]>}
 */
export function parsePromoXlsx(filePath, year) {
  const wb = XLSX.readFile(filePath, {cellDates: false, raw: false})
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) return []
  expandSheetRef(sheet)

  let maxR = 0
  const decoded = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null
  if (decoded) maxR = decoded.e.r + 1

  /** @type {Array<[string, string, number, number, number, number, number]>} */
  const rows = []
  // Row1 notice, Row2 header, data from Row3
  // H=消耗 P=直接支付金额 I=曝光 J=点击 X=商详访问数
  for (let excelRow = 3; excelRow <= maxR; excelRow++) {
    const md = sheet[`A${excelRow}`]?.v
    const spuidRaw = sheet[`G${excelRow}`]?.v
    if (md == null && spuidRaw == null) continue
    const ymd = mdToYmd(md, year)
    const spuid = String(spuidRaw ?? '').trim()
    if (!ymd || !spuid) continue
    const cost = parseNumber(sheet[`H${excelRow}`]?.v)
    const impressions = parseNumber(sheet[`I${excelRow}`]?.v)
    const clicks = parseNumber(sheet[`J${excelRow}`]?.v)
    const directPay = parseNumber(sheet[`P${excelRow}`]?.v)
    const detailVisits = parseNumber(sheet[`X${excelRow}`]?.v)
    rows.push([ymd, spuid, cost, directPay, impressions, clicks, detailVisits])
  }
  return rows
}

/**
 * Aggregate 得物推数据 by SPUID within [startDate, endDate].
 * @returns {Map<string, {
 *   recommendPayAmount: number,
 *   recommendCost: number,
 *   recommendRoi: number|null,
 *   recommendImpressions: number,
 *   recommendClicks: number,
 *   recommendDetailVisits: number,
 * }>}
 */
export async function aggregatePromoBySpuid(root, startDate, endDate, onProgress) {
  if (!startDate || !endDate) return new Map()
  if (onProgress) {
    await onProgress({
      type: 'progress',
      phase: 'promo',
      done: 0,
      total: 1,
      label: '查询得物推汇总',
    })
  }
  await yieldEventLoop()
  const db = await requireDb(root)
  const map = await queryPromoAgg(db, {start: startDate, end: endDate})
  if (onProgress) {
    await onProgress({
      type: 'progress',
      phase: 'promo',
      done: 1,
      total: 1,
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
      recommendImpressions: promo ? promo.recommendImpressions : 0,
      recommendClicks: promo ? promo.recommendClicks : 0,
      recommendDetailVisits: promo ? promo.recommendDetailVisits : 0,
    }
  })
}

/** 与明细清单累加一致：只加当前结果集里的行 */
function sumPromoFromRows(rows) {
  let recommendPayAmount = 0
  let recommendCost = 0
  let recommendImpressions = 0
  let recommendClicks = 0
  let recommendDetailVisits = 0
  for (const row of rows || []) {
    recommendPayAmount += Number(row.recommendPayAmount) || 0
    recommendCost += Number(row.recommendCost) || 0
    recommendImpressions += Number(row.recommendImpressions) || 0
    recommendClicks += Number(row.recommendClicks) || 0
    recommendDetailVisits += Number(row.recommendDetailVisits) || 0
  }
  return {
    recommendPayAmount: {总和: round2(recommendPayAmount)},
    recommendCost: {总和: round2(recommendCost)},
    recommendRoi: {
      总和: recommendCost === 0 ? null : round2(recommendPayAmount / recommendCost),
    },
    recommendImpressions: {总和: round2(recommendImpressions)},
    recommendClicks: {总和: round2(recommendClicks)},
    recommendDetailVisits: {总和: round2(recommendDetailVisits)},
  }
}

async function attachPromoToComparePeriod(root, period) {
  if (!period || period.error || !period.startDate || !period.endDate) return period
  try {
    const promoMap = await aggregatePromoBySpuid(root, period.startDate, period.endDate)
    period.rows = attachPromoMetrics(period.rows || [], promoMap)
    if (period.summary) {
      Object.assign(period.summary, sumPromoFromRows(period.rows))
    }
  } catch (err) {
    console.warn('对比期得物推汇总失败:', err.message)
    period.rows = attachPromoMetrics(period.rows || [], new Map())
    if (period.summary) {
      Object.assign(period.summary, sumPromoFromRows(period.rows))
    }
  }
  return period
}


export function parseDateFromFilename(name) {
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

export async function listShopDates(root, shop) {
  if (!(await dbExists(root))) return []
  return await listShopDatesFromDb(await openDb(root), shop)
}

export function shopDateExists(root, shop, date) {
  if (!SHOPS[shop] || !date) return false
  return fs.existsSync(path.join(shopDir(root, shop), `${date}.xlsx`))
}

/**
 * Save buffer as YYYYMMDD.xlsx into shop folder, then upsert Postgres.
 * @returns {Promise<{ ok: boolean, error?: string, date?: string, shop?: string, rowCount?: number }>}
 */
export async function saveUploadedShopFile(root, shop, date, buffer) {
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
  let wroteDb = false
  try {
    fs.writeFileSync(tmp, buffer)
    const rows = parseXlsxRows(tmp, shop, date)
    fs.renameSync(tmp, dest)
    const db = await openDb(root)
    await upsertShopDay(db, shop, date, rows)
    const catNames = rows.map((r) => r.category).filter(Boolean)
    const catResult = await upsertCategories(db, catNames)
    wroteDb = true
    return {
      ok: true,
      shop,
      date,
      rowCount: rows.length,
      newCategories: catResult.added,
      newCategoryNames: catResult.addedNames,
    }
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
    if (wroteDb) {
      try {
        await deleteShopDay(await openDb(root), shop, date)
      } catch {
        /* ignore */
      }
    }
    return {ok: false, error: `文件无法解析：${err.message || err}`}
  }
}

async function removeShopDateFile(root, shop, date) {
  const dest = path.join(shopDir(root, shop), `${date}.xlsx`)
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest)
  } catch {
    /* ignore */
  }
  try {
    if (await dbExists(root)) await deleteShopDay(await openDb(root), shop, date)
  } catch {
    /* ignore */
  }
}

/**
 * Validate paired uploads then save. Filenames must be 大店YYYYMMDD.xlsx / 小店YYYYMMDD.xlsx.
 * Each date must include both shops; no partial write on failure.
 * @param {{ originalname: string, buffer: Buffer }[]} files
 */
export async function savePairedUploads(root, files) {
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
    const saved = await saveUploadedShopFile(root, item.shop, item.date, item.buffer)
    if (!saved.ok) {
      for (const w of written) await removeShopDateFile(root, w.shop, w.date)
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
        newCategories: saved.newCategories || 0,
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

/**
 * Save one 得物推 xlsx into 得物推数据/ and upsert Postgres.
 * @returns {Promise<{ ok: boolean, error?: string, fileName?: string, start?: string, end?: string, rowCount?: number }>}
 */
export async function saveUploadedPromoFile(root, fileName, buffer) {
  const parsed = parsePromoFilename(fileName)
  if (!parsed) {
    return {ok: false, error: '命名须为 YYYY.M.D-YYYY.M.D.xlsx 或 YYYY.M.D.xlsx'}
  }

  const dir = promoDir(root)
  fs.mkdirSync(dir, {recursive: true})
  const dest = path.join(dir, parsed.fileName)
  if (fs.existsSync(dest)) {
    return {ok: false, error: `已存在文件 ${parsed.fileName}`}
  }

  const conflict = await findPromoConflict(root, parsed.start, parsed.end)
  if (conflict) {
    return {ok: false, error: conflict.reason}
  }

  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`
  let wroteDb = false
  try {
    fs.writeFileSync(tmp, buffer)
    const rows = parsePromoXlsx(tmp, parsed.year)
    if (!rows.length) {
      throw new Error('未解析到有效数据行（请确认表头与列：日期/商品ID/消耗/直接支付金额）')
    }
    fs.renameSync(tmp, dest)
    const db = await openDb(root)
    await upsertPromoRows(db, rows, {start: parsed.start, end: parsed.end})
    wroteDb = true
    const relPath = `得物推数据/${parsed.fileName}`
    const mtimeMs = fs.statSync(dest).mtimeMs
    await setMetaFile(db, 'promo', relPath, mtimeMs)
    return {
      ok: true,
      fileName: parsed.fileName,
      start: parsed.start,
      end: parsed.end,
      rowCount: rows.length,
    }
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
    if (wroteDb) {
      try {
        const db = await openDb(root)
        await deletePromoRange(db, parsed.start, parsed.end)
        await deleteMetaFile(db, 'promo', `得物推数据/${parsed.fileName}`)
      } catch {
        /* ignore */
      }
    }
    return {ok: false, error: `文件无法解析：${err.message || err}`}
  }
}

async function removePromoFile(root, fileName, start, end) {
  const dest = path.join(promoDir(root), fileName)
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest)
  } catch {
    /* ignore */
  }
  try {
    const db = await openDb(root)
    if (start && end) await deletePromoRange(db, start, end)
    await deleteMetaFile(db, 'promo', `得物推数据/${fileName}`)
  } catch {
    /* ignore */
  }
}

/**
 * Validate and save 得物推 uploads. No partial write on failure.
 * @param {{ originalname: string, buffer: Buffer }[]} files
 */
export async function savePromoUploads(root, files) {
  /** @type {{ name: string, ok: boolean, fileName?: string, start?: string, end?: string, rowCount?: number, error?: string }[]} */
  const results = []
  /** @type {{ name: string, fileName: string, start: string, end: string, year: number, buffer: Buffer }[]} */
  const prepared = []
  /** @type {Map<string, string>} */
  const seenName = new Map()

  for (const file of files) {
    const name = file.originalname || 'unknown.xlsx'
    if (!/\.xlsx$/i.test(name)) {
      results.push({name, ok: false, error: '仅支持 .xlsx'})
      continue
    }
    const parsed = parsePromoFilename(name)
    if (!parsed) {
      results.push({
        name,
        ok: false,
        error: '命名须为 YYYY.M.D-YYYY.M.D.xlsx（区间）或 YYYY.M.D.xlsx（单日）',
      })
      continue
    }
    if (seenName.has(parsed.fileName.toLowerCase())) {
      results.push({
        name,
        ok: false,
        fileName: parsed.fileName,
        start: parsed.start,
        end: parsed.end,
        error: `与 ${seenName.get(parsed.fileName.toLowerCase())} 重复`,
      })
      continue
    }
    seenName.set(parsed.fileName.toLowerCase(), name)

    const conflict = await findPromoConflict(root, parsed.start, parsed.end)
    if (conflict) {
      results.push({
        name,
        ok: false,
        fileName: parsed.fileName,
        start: parsed.start,
        end: parsed.end,
        error: conflict.reason,
      })
      continue
    }

    prepared.push({
      name,
      fileName: parsed.fileName,
      start: parsed.start,
      end: parsed.end,
      year: parsed.year,
      buffer: file.buffer,
    })
    results.push({
      name,
      ok: true,
      fileName: parsed.fileName,
      start: parsed.start,
      end: parsed.end,
    })
  }

  // Within-batch range overlap
  const overlapErrors = new Map()
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const a = prepared[i]
      const b = prepared[j]
      if (rangesOverlap(a.start, a.end, b.start, b.end)) {
        const msg = `与同批次 ${b.name}（${b.start}~${b.end}）日期重叠`
        if (!overlapErrors.has(a.name)) overlapErrors.set(a.name, msg)
        if (!overlapErrors.has(b.name)) {
          overlapErrors.set(b.name, `与同批次 ${a.name}（${a.start}~${a.end}）日期重叠`)
        }
      }
    }
  }

  if (overlapErrors.size || results.some((r) => !r.ok)) {
    return {
      ok: false,
      results: results.map((r) => {
        if (!r.ok) return r
        if (overlapErrors.has(r.name)) {
          return {...r, ok: false, error: overlapErrors.get(r.name)}
        }
        return {...r, ok: false, error: '同批次存在无效文件，已取消写入'}
      }),
      okCount: 0,
      failCount: results.length,
      saved: false,
    }
  }

  /** @type {{ fileName: string, start: string, end: string }[]} */
  const written = []
  for (const item of prepared) {
    const saved = await saveUploadedPromoFile(root, item.fileName, item.buffer)
    if (!saved.ok) {
      for (const w of written) await removePromoFile(root, w.fileName, w.start, w.end)
      return {
        ok: false,
        results: results.map((r) => {
          if (r.name === item.name) {
            return {...r, ok: false, error: saved.error || '写入失败'}
          }
          if (written.some((w) => w.fileName === r.fileName)) {
            return {...r, ok: false, error: '同批次写入失败，已回滚'}
          }
          return {...r, ok: false, error: '同批次写入失败，已取消'}
        }),
        okCount: 0,
        failCount: results.length,
        saved: false,
      }
    }
    written.push({fileName: item.fileName, start: item.start, end: item.end})
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

export function parseXlsxRows(filePath, shop, date) {
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

export async function listAvailableDates(root, shops = Object.keys(SHOPS)) {
  if (!(await dbExists(root))) return []
  return await listAvailableDatesFromDb(await openDb(root), shops)
}

/**
 * @param {(done:number,total:number,info?:object)=>void|Promise<void>} [onProgress]
 */
export async function loadRowsForRange(root, shops, start, end, onProgress) {
  if (onProgress) await onProgress(0, 1, {shop: '', date: '', starting: true})
  await yieldEventLoop()
  const db = await requireDb(root)
  const rows = await queryShopRows(db, {
    start: start || null,
    end: end || null,
    shops: shops?.length ? shops : null,
  })
  if (onProgress) await onProgress(1, 1, {shop: shops?.[0] || '', date: `${start || ''}~${end || ''}`})
  return rows
}

function categoryPath(category) {
  return category.split('-').map((s) => s.trim()).filter(Boolean)
}

export function buildCategoryTree(rows) {
  return buildCategoryTreeFromNames(rows.map((r) => r?.category).filter(Boolean))
}

/**
 * @param {Iterable<string>} names full category paths like 服装-外套-冲锋衣
 */
export function buildCategoryTreeFromNames(names) {
  const root = {}
  for (const name of names || []) {
    const category = String(name || '').trim()
    if (!category) continue
    const parts = categoryPath(category)
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
  const keys = [
    'payAmount',
    'detailVisitors',
    'favorites',
    'payUsers',
    'recommendPayAmount',
    'recommendCost',
    'recommendRoi',
    'recommendImpressions',
    'recommendClicks',
    'recommendDetailVisits',
  ]

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

async function loadBigTrafficRows(root, startDate, endDate, filters) {
  const raw = await loadRowsForRange(root, ['大店'], startDate || null, endDate || null)
  return filterRows(raw, filters)
}

function applyBigTrafficToSummary(summary, bigTrafficRows) {
  const big = summarize(bigTrafficRows)
  summary.detailVisitors = big.detailVisitors
  summary.favorites = big.favorites
  return summary
}

async function summarizeFilteredRange(root, shops, startDate, endDate, filters) {
  const raw = await loadRowsForRange(root, shops, startDate, endDate)
  const filtered = filterRows(raw, filters)
  const needExtraBig = !shops.includes('大店')
  const bigTrafficRows = needExtraBig
    ? await loadBigTrafficRows(root, startDate, endDate, filters)
    : filtered.filter((r) => r.shop === '大店')
  const summary = summarize(filtered)
  if (needExtraBig) applyBigTrafficToSummary(summary, bigTrafficRows)
  return {
    summary,
    rows: mergeDetailRows(filtered, {trafficRows: bigTrafficRows}),
    matchedRawRows: filtered.length,
    startDate,
    endDate,
  }
}

/**
 * 合并明细。支付等按传入 rows 累计；商详/收藏始终取大店（可另传 trafficRows）。
 * @param {object[]} rows
 * @param {{ trafficRows?: object[] }} [options]
 */
export function mergeDetailRows(rows, options = {}) {
  /** @type {Map<string, object>} */
  const map = new Map()
  const trafficSource = Array.isArray(options.trafficRows) ? options.trafficRows : rows

  /** @type {Map<string, { detailVisitors: number, favorites: number }>} */
  const trafficBySpuid = new Map()
  for (const r of trafficSource) {
    if (r.shop !== '大店') continue
    let t = trafficBySpuid.get(r.spuid)
    if (!t) {
      t = {detailVisitors: 0, favorites: 0}
      trafficBySpuid.set(r.spuid, t)
    }
    t.detailVisitors += r.detailVisitors
    t.favorites += r.favorites
  }

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

  for (const [spuid, item] of map) {
    const t = trafficBySpuid.get(spuid)
    if (t) {
      item.detailVisitors = t.detailVisitors
      item.favorites = t.favorites
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

export async function getMeta(root) {
  const promoFiles = listPromoFiles(root).map((f) => ({
    fileName: f.fileName,
    start: f.start,
    end: f.end,
  }))
  if (!(await dbExists(root))) {
    return {
      shops: Object.keys(SHOPS),
      dates: [],
      minDate: null,
      maxDate: null,
      fileCounts: {大店: 0, 小店: 0},
      fileDates: {大店: [], 小店: []},
      promoFiles,
      dbReady: false,
    }
  }
  return {...await getMetaFromDb(await openDb(root)), promoFiles, dbReady: true}
}

/** 类目树来自 categories 表（全量），不再按日期/店铺实时扫表 */
export async function getCategories(root) {
  if (!(await dbExists(root))) return []
  const names = await listCategoryNames(await openDb(root))
  return buildCategoryTreeFromNames(names)
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
          ? '从数据库查询中'
          : info
            ? `${info.shop || '店铺'} ${info.date || ''}`.trim()
            : '',
      })
    }
  })

  if (onProgress) {
    await onProgress({type: 'progress', phase: 'aggregate', done: 1, total: 1, label: '汇总中'})
  }

  const filtered = filterRows(raw, filters)
  const needExtraBig = !shops.includes('大店')
  const bigTrafficRows = needExtraBig
    ? await loadBigTrafficRows(root, startDate, endDate, filters)
    : filtered.filter((r) => r.shop === '大店')
  const rows = mergeDetailRows(filtered, {trafficRows: bigTrafficRows})
  const summary = summarize(filtered)
  if (needExtraBig) applyBigTrafficToSummary(summary, bigTrafficRows)

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

  if (onProgress) {
    await onProgress({type: 'progress', phase: 'promo', done: 0, total: 1, label: '汇总得物推数据'})
  }
  let detailRows = rows
  try {
    const promoMap = await aggregatePromoBySpuid(root, startDate || null, endDate || null, onProgress)
    detailRows = attachPromoMetrics(detailRows, promoMap)
  } catch (err) {
    console.warn('得物推汇总失败:', err.message)
    detailRows = attachPromoMetrics(detailRows, new Map())
  }

  // 对比期也挂上得物推，再算明细环比/同比（含得物推三项）
  if (periodType) {
    if (onProgress) {
      await onProgress({type: 'progress', phase: 'promo', done: 0, total: 1, label: '汇总对比期得物推'})
    }
    await Promise.all([
      attachPromoToComparePeriod(root, compare.yoy),
      attachPromoToComparePeriod(root, compare.pop),
    ])
    detailRows = attachRowCompare(
      detailRows,
      compare.yoy?.rows || [],
      compare.pop?.rows || [],
    )
  }

  Object.assign(summary, sumPromoFromRows(detailRows))

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

/** Open DB on startup; no longer preloads xlsx into memory. */
export async function warmCache(root) {
  if (!(await dbExists(root))) {
    console.warn('数据库未就绪，请检查 DATABASE_URL 与 Postgres 服务')
    return
  }
  try {
    const meta = await getMetaFromDb(await openDb(root))
    console.log(`Postgres 已就绪: ${meta.minDate || '-'} ~ ${meta.maxDate || '-'}`)
  } catch (err) {
    console.warn('打开 Postgres 失败:', err.message)
  }
}
