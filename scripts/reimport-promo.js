#!/usr/bin/env node
/**
 * 强制重导 得物推数据 → Postgres（含曝光/点击/商详访问数）
 * 用法: node scripts/reimport-promo.js
 */
import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'
import {
  openDb,
  closeDb,
  upsertPromoRows,
  setMetaFile,
  queryPromoAgg,
} from '../server/db.js'
import {parsePromoFilename, parsePromoXlsx} from '../server/dataService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function listPromoFiles() {
  const dir = path.join(root, '得物推数据')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .map((name) => {
      const info = parsePromoFilename(name)
      if (!info) return null
      return {
        ...info,
        filePath: path.join(dir, info.fileName),
        relPath: `得物推数据/${info.fileName}`,
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.start.localeCompare(b.start))
}

async function main() {
  console.log(`根目录: ${root}`)
  const db = await openDb(root)

  const files = listPromoFiles()
  if (!files.length) {
    throw new Error('得物推数据/ 下没有可解析的 xlsx')
  }

  let imported = 0
  let totalRows = 0
  let sumImpressions = 0
  let sumClicks = 0
  let sumDetailVisits = 0

  console.log(`[得物推] 强制重导 ${files.length} 个文件`)
  for (const f of files) {
    const mtimeMs = fs.statSync(f.filePath).mtimeMs
    console.log(`  解析 ${f.fileName} (${f.start}~${f.end}) …`)
    const t0 = Date.now()
    const rows = parsePromoXlsx(f.filePath, f.year)
    // 抽样校验新字段
    let fileImp = 0
    let fileClk = 0
    let fileVis = 0
    for (const row of rows) {
      fileImp += Number(row[4]) || 0
      fileClk += Number(row[5]) || 0
      fileVis += Number(row[6]) || 0
    }
    await upsertPromoRows(db, rows, {start: f.start, end: f.end})
    await setMetaFile(db, 'promo', f.relPath, mtimeMs)
    imported += 1
    totalRows += rows.length
    sumImpressions += fileImp
    sumClicks += fileClk
    sumDetailVisits += fileVis
    console.log(
      `  完成 ${f.fileName}：${rows.length} 行，曝光合计 ${Math.round(fileImp)}，点击 ${Math.round(fileClk)}，商详 ${Math.round(fileVis)}，${((Date.now() - t0) / 1000).toFixed(1)}s`,
    )
  }

  // 用一段已导入区间做库内校验
  const sample = files[files.length - 1]
  const map = await queryPromoAgg(db, {start: sample.start, end: sample.end})
  let dbImp = 0
  let dbClk = 0
  let dbVis = 0
  for (const v of map.values()) {
    dbImp += v.recommendImpressions || 0
    dbClk += v.recommendClicks || 0
    dbVis += v.recommendDetailVisits || 0
  }

  console.log('\n======== 得物推重导完成 ========')
  console.log(`文件: ${imported}，写入约 ${totalRows} 行`)
  console.log(
    `解析合计: 曝光 ${Math.round(sumImpressions)} / 点击 ${Math.round(sumClicks)} / 商详 ${Math.round(sumDetailVisits)}`,
  )
  console.log(
    `库内抽查 ${sample.start}~${sample.end}: 曝光 ${Math.round(dbImp)} / 点击 ${Math.round(dbClk)} / 商详 ${Math.round(dbVis)} · SPU ${map.size}`,
  )

  await closeDb()
}

main().catch(async (err) => {
  console.error('重导失败:', err)
  await closeDb().catch(() => {})
  process.exit(1)
})
