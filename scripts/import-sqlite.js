#!/usr/bin/env node
/**
 * 全量导入 大店/小店/得物推数据 → Postgres
 * 用法: npm run import:db
 * 可重跑：按文件 mtime 增量跳过；强制全量加 --force
 */
import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'
import {
  openDb,
  closeDb,
  upsertShopDay,
  upsertPromoRows,
  getMetaFileMtime,
  setMetaFile,
  getMetaFromDb,
  collectCategoriesFromShopDaily,
  listCategoryNames,
} from '../server/db.js'
import {
  parseDateFromFilename,
  parseXlsxRows,
  parsePromoFilename,
  parsePromoXlsx,
} from '../server/dataService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const force = process.argv.includes('--force')

const SHOPS = ['大店', '小店']

function listShopFiles(shop) {
  const dir = path.join(root, shop)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .map((name) => {
      const date = parseDateFromFilename(name)
      if (!date) return null
      return {
        shop,
        date,
        fileName: name,
        filePath: path.join(dir, name),
        relPath: `${shop}/${name}`,
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date))
}

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

async function shouldSkip(db, kind, relPath, mtimeMs) {
  if (force) return false
  const prev = await getMetaFileMtime(db, kind, relPath)
  return prev != null && prev === mtimeMs
}

async function main() {
  console.log(`导入根目录: ${root}`)
  if (force) console.log('模式: --force 全量重导')

  const db = await openDb(root)
  let shopImported = 0
  let shopSkipped = 0
  let shopRows = 0
  let promoImported = 0
  let promoSkipped = 0
  let promoRows = 0

  for (const shop of SHOPS) {
    const files = listShopFiles(shop)
    console.log(`\n[${shop}] 共 ${files.length} 个文件`)
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const mtimeMs = fs.statSync(f.filePath).mtimeMs
      if (await shouldSkip(db, 'shop', f.relPath, mtimeMs)) {
        shopSkipped += 1
        continue
      }
      const rows = parseXlsxRows(f.filePath, f.shop, f.date)
      await upsertShopDay(db, f.shop, f.date, rows)
      await setMetaFile(db, 'shop', f.relPath, mtimeMs)
      shopImported += 1
      shopRows += rows.length
      if (shopImported % 20 === 0 || i === files.length - 1) {
        console.log(`  ${shop} 已导入 ${shopImported}（跳过 ${shopSkipped}）… 当前 ${f.date} ${rows.length} 行`)
      }
    }
  }

  const promoFiles = listPromoFiles()
  console.log(`\n[得物推] 共 ${promoFiles.length} 个文件`)
  for (const f of promoFiles) {
    const mtimeMs = fs.statSync(f.filePath).mtimeMs
    if (await shouldSkip(db, 'promo', f.relPath, mtimeMs)) {
      promoSkipped += 1
      console.log(`  跳过 ${f.fileName}`)
      continue
    }
    console.log(`  解析 ${f.fileName} …`)
    const t0 = Date.now()
    const rows = parsePromoXlsx(f.filePath, f.year)
    await upsertPromoRows(db, rows, {start: f.start, end: f.end})
    await setMetaFile(db, 'promo', f.relPath, mtimeMs)
    promoImported += 1
    promoRows += rows.length
    console.log(`  完成 ${f.fileName}：${rows.length} 行，${((Date.now() - t0) / 1000).toFixed(1)}s`)
  }

  const meta = await getMetaFromDb(db)
  const cat = await collectCategoriesFromShopDaily(db)
  console.log('\n======== 导入完成 ========')
  console.log(`店铺文件: 导入 ${shopImported}，跳过 ${shopSkipped}，写入约 ${shopRows} 行`)
  console.log(`得物推: 导入 ${promoImported}，跳过 ${promoSkipped}，写入约 ${promoRows} 行`)
  console.log(`类目: 新增 ${cat.added}，当前共 ${(await listCategoryNames(db)).length}`)
  console.log(`库内日期: ${meta.minDate || '-'} ~ ${meta.maxDate || '-'}`)
  console.log(`文件数: 大店 ${meta.fileCounts.大店} / 小店 ${meta.fileCounts.小店}`)

  await closeDb()
}

main().catch(async (err) => {
  console.error('导入失败:', err)
  await closeDb()
  process.exit(1)
})
