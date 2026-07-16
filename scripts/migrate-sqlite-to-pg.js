#!/usr/bin/env node
/**
 * 一次性：把 SQLite (data/dewu.sqlite 或 backups/dewu.sqlite) 全量迁入 Postgres。
 * 用法: DATABASE_URL=... node scripts/migrate-sqlite-to-pg.js [sqlitePath]
 */
import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'
import Database from 'better-sqlite3'
import {openDb, closeDb} from '../server/db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const sqlitePath = path.resolve(
  process.argv[2] ||
    (fs.existsSync(path.join(root, 'backups', 'dewu.sqlite'))
      ? path.join(root, 'backups', 'dewu.sqlite')
      : path.join(root, 'data', 'dewu.sqlite')),
)

const TABLES = [
  {
    name: 'shop_daily',
    columns: [
      'shop',
      'date',
      'spuid',
      'sku',
      'category',
      'pay_amount',
      'detail_visitors',
      'favorites',
      'pay_users',
    ],
  },
  {
    name: 'promo_daily',
    columns: ['date', 'spuid', 'cost', 'direct_pay'],
  },
  {
    name: 'meta_files',
    columns: ['kind', 'path', 'mtime_ms'],
  },
  {
    name: 'users',
    columns: ['id', 'username', 'password_hash', 'created_at'],
  },
  {
    name: 'categories',
    columns: ['name'],
  },
  {
    name: 'schema_migrations',
    columns: ['id', 'applied_at'],
  },
]

async function copyTable(sqlite, pool, {name, columns}) {
  const exists = sqlite
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name)
  if (!exists) {
    console.log(`[skip] 表不存在: ${name}`)
    return 0
  }

  const total = sqlite.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get().c
  console.log(`[${name}] SQLite 行数: ${total}`)
  if (!total) return 0

  await pool.query(`TRUNCATE TABLE ${name} RESTART IDENTITY CASCADE`)

  const selectSql = `SELECT ${columns.join(', ')} FROM ${name}`
  const stmt = sqlite.prepare(selectSql)
  const BATCH = 1000
  let inserted = 0
  let batch = []

  const flush = async () => {
    if (!batch.length) return
    const values = []
    const params = []
    let p = 1
    for (const row of batch) {
      values.push(`(${columns.map(() => `$${p++}`).join(', ')})`)
      for (const col of columns) params.push(row[col])
    }
    await pool.query(
      `INSERT INTO ${name} (${columns.join(', ')}) VALUES ${values.join(',')}`,
      params,
    )
    inserted += batch.length
    batch = []
    if (inserted % 20000 === 0 || inserted === total) {
      console.log(`  … ${inserted}/${total}`)
    }
  }

  for (const row of stmt.iterate()) {
    batch.push(row)
    if (batch.length >= BATCH) await flush()
  }
  await flush()

  if (name === 'users') {
    await pool.query(`
      SELECT setval(pg_get_serial_sequence('users', 'id'), COALESCE((SELECT MAX(id) FROM users), 1), true)
    `)
  }

  return inserted
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('请设置 DATABASE_URL')
  }
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`找不到 SQLite 文件: ${sqlitePath}`)
  }

  console.log(`SQLite: ${sqlitePath}`)
  console.log(`Postgres: ${process.env.DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}`)

  const sqlite = new Database(sqlitePath, {readonly: true, fileMustExist: true})
  const pool = await openDb(root)

  let sum = 0
  for (const table of TABLES) {
    sum += await copyTable(sqlite, pool, table)
  }

  sqlite.close()
  await closeDb()
  console.log(`\n迁移完成，共写入约 ${sum} 行`)
}

main().catch(async (err) => {
  console.error('迁移失败:', err)
  await closeDb()
  process.exit(1)
})
