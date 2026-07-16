import './loadEnv.js'
import {randomBytes, scryptSync, timingSafeEqual} from 'crypto'
import pg from 'pg'

const {Pool} = pg

/** @type {pg.Pool | null} */
let cachedPool = null

function databaseUrl() {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('缺少环境变量 DATABASE_URL')
  }
  return url
}

/**
 * @param {string} [_root]
 * @returns {Promise<pg.Pool>}
 */
export async function openDb(_root) {
  if (cachedPool) return cachedPool

  const pool = new Pool({
    connectionString: databaseUrl(),
    max: Number(process.env.PG_POOL_MAX) || 10,
  })

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_daily (
      shop TEXT NOT NULL,
      date TEXT NOT NULL,
      spuid TEXT NOT NULL,
      sku TEXT,
      category TEXT,
      pay_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      detail_visitors DOUBLE PRECISION NOT NULL DEFAULT 0,
      favorites DOUBLE PRECISION NOT NULL DEFAULT 0,
      pay_users DOUBLE PRECISION NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_shop_daily_shop_date ON shop_daily(shop, date);
    CREATE INDEX IF NOT EXISTS idx_shop_daily_date_spuid ON shop_daily(date, spuid);
    CREATE INDEX IF NOT EXISTS idx_shop_daily_category ON shop_daily(category);

    CREATE TABLE IF NOT EXISTS promo_daily (
      date TEXT NOT NULL,
      spuid TEXT NOT NULL,
      cost DOUBLE PRECISION NOT NULL DEFAULT 0,
      direct_pay DOUBLE PRECISION NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_promo_daily_date_spuid ON promo_daily(date, spuid);

    CREATE TABLE IF NOT EXISTS meta_files (
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      mtime_ms DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (kind, path)
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS categories (
      name TEXT PRIMARY KEY NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  await ensureDefaultAdmin(pool)

  cachedPool = pool
  return pool
}

const DEFAULT_ADMIN_USER = 'admin'
const DEFAULT_ADMIN_PASS = 'KCktBkww4tGFXpSX'

/**
 * password_hash format: saltHex:hashHex (scrypt)
 * @param {string} password
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(String(password), salt, 64).toString('hex')
  return `${salt}:${hash}`
}

/**
 * @param {string} password
 * @param {string} stored
 */
export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':')
  if (!salt || !hash) return false
  const expected = Buffer.from(hash, 'hex')
  const actual = scryptSync(String(password), salt, 64)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/**
 * @param {pg.Pool} db
 */
async function ensureDefaultAdmin(db) {
  const {rows} = await db.query('SELECT id FROM users WHERE username = $1', [DEFAULT_ADMIN_USER])
  if (rows[0]) return
  await db.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [
    DEFAULT_ADMIN_USER,
    hashPassword(DEFAULT_ADMIN_PASS),
  ])
}

/**
 * @param {pg.Pool} db
 * @param {string} username
 */
export async function findUserByUsername(db, username) {
  const {rows} = await db.query(
    'SELECT id, username, password_hash FROM users WHERE username = $1',
    [String(username || '')],
  )
  return rows[0] || null
}

/**
 * @param {pg.Pool} db
 * @param {string} id
 */
export async function hasMigration(db, id) {
  const {rows} = await db.query('SELECT 1 AS ok FROM schema_migrations WHERE id = $1', [
    String(id || ''),
  ])
  return Boolean(rows[0])
}

/**
 * @param {pg.Pool} db
 * @param {string} id
 */
export async function markMigration(db, id) {
  await db.query(
    'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
    [String(id || '')],
  )
}

/**
 * @param {pg.Pool} db
 * @returns {Promise<string[]>}
 */
export async function listCategoryNames(db) {
  const {rows} = await db.query('SELECT name FROM categories ORDER BY LOWER(name)')
  return rows.map((r) => String(r.name))
}

/**
 * Insert missing category full-path names. Returns newly added names.
 * @param {pg.Pool} db
 * @param {Iterable<string>} names
 * @returns {Promise<{ added: number, addedNames: string[] }>}
 */
export async function upsertCategories(db, names) {
  /** @type {string[]} */
  const addedNames = []
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    for (const raw of names || []) {
      const name = String(raw || '').trim()
      if (!name || /^null(-null)*$/i.test(name)) continue
      const {rowCount} = await client.query(
        'INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
        [name],
      )
      if (rowCount > 0) addedNames.push(name)
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return {added: addedNames.length, addedNames}
}

/**
 * Collect DISTINCT category from shop_daily into categories table.
 * @param {pg.Pool} db
 */
export async function collectCategoriesFromShopDaily(db) {
  const {rows} = await db.query(`
    SELECT DISTINCT category AS name FROM shop_daily
    WHERE category IS NOT NULL AND TRIM(category) != ''
  `)
  return upsertCategories(db, rows.map((r) => r.name))
}

export async function closeDb() {
  if (cachedPool) {
    try {
      await cachedPool.end()
    } catch {
      /* ignore */
    }
    cachedPool = null
  }
}

/**
 * Postgres 已配置即可用；空库也算就绪（可直接导入）。
 * @param {string} [_root]
 */
export async function dbExists(_root) {
  try {
    const db = await openDb(_root)
    await db.query('SELECT 1')
    return true
  } catch {
    return false
  }
}

/**
 * @param {pg.Pool | pg.PoolClient} client
 * @param {string} sql
 * @param {unknown[]} params
 * @param {Array<{spuid:string,sku?:string,category?:string,payAmount?:number,detailVisitors?:number,favorites?:number,payUsers?:number}>} rows
 * @param {string} shop
 * @param {string} date
 */
async function insertShopRows(client, shop, date, rows) {
  const list = (rows || []).filter((r) => r?.spuid)
  const BATCH = 500
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH)
    const values = []
    const params = []
    let p = 1
    for (const r of chunk) {
      values.push(
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`,
      )
      params.push(
        shop,
        date,
        String(r.spuid),
        String(r.sku ?? ''),
        String(r.category ?? ''),
        Number(r.payAmount) || 0,
        Number(r.detailVisitors) || 0,
        Number(r.favorites) || 0,
        Number(r.payUsers) || 0,
      )
    }
    await client.query(
      `INSERT INTO shop_daily (
        shop, date, spuid, sku, category,
        pay_amount, detail_visitors, favorites, pay_users
      ) VALUES ${values.join(',')}`,
      params,
    )
  }
}

/**
 * Replace all shop rows for one shop+date.
 * @param {pg.Pool} db
 * @param {string} shop
 * @param {string} date
 * @param {Array<{spuid:string,sku?:string,category?:string,payAmount?:number,detailVisitors?:number,favorites?:number,payUsers?:number}>} rows
 */
export async function upsertShopDay(db, shop, date, rows) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM shop_daily WHERE shop = $1 AND date = $2', [shop, date])
    await insertShopRows(client, shop, date, rows)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/**
 * Delete shop rows for one shop+date (rollback helper).
 * @param {pg.Pool} db
 */
export async function deleteShopDay(db, shop, date) {
  await db.query('DELETE FROM shop_daily WHERE shop = $1 AND date = $2', [shop, date])
}

/**
 * @param {pg.Pool} db
 * @param {string} start YYYYMMDD
 * @param {string} end YYYYMMDD
 */
export async function deletePromoRange(db, start, end) {
  await db.query('DELETE FROM promo_daily WHERE date >= $1 AND date <= $2', [start, end])
}

/**
 * @param {pg.Pool} db
 * @param {string} start
 * @param {string} end
 */
export async function promoRangeHasData(db, start, end) {
  const {rows} = await db.query(
    'SELECT 1 AS ok FROM promo_daily WHERE date >= $1 AND date <= $2 LIMIT 1',
    [start, end],
  )
  return Boolean(rows[0])
}

/**
 * @param {pg.Pool} db
 * @param {'shop'|'promo'} kind
 * @param {string} relPath
 */
export async function deleteMetaFile(db, kind, relPath) {
  await db.query('DELETE FROM meta_files WHERE kind = $1 AND path = $2', [kind, relPath])
}

/**
 * @param {pg.Pool | pg.PoolClient} client
 * @param {Array<[string, string, number, number]>} rows
 */
async function insertPromoRows(client, rows) {
  const list = (rows || []).filter((row) => row?.[0] && row?.[1])
  const BATCH = 500
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH)
    const values = []
    const params = []
    let p = 1
    for (const row of chunk) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++})`)
      params.push(row[0], String(row[1]), Number(row[2]) || 0, Number(row[3]) || 0)
    }
    await client.query(
      `INSERT INTO promo_daily (date, spuid, cost, direct_pay) VALUES ${values.join(',')}`,
      params,
    )
  }
}

/**
 * Replace promo rows for a set of dates covered by one source file.
 * @param {pg.Pool} db
 * @param {Array<[string, string, number, number]>} rows compact [ymd, spuid, cost, directPay]
 * @param {{ start?: string, end?: string } | null} [range] optional date range to clear first
 */
export async function upsertPromoRows(db, rows, range = null) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    if (range?.start && range?.end) {
      await client.query('DELETE FROM promo_daily WHERE date >= $1 AND date <= $2', [
        range.start,
        range.end,
      ])
    } else {
      const dates = new Set()
      for (const row of rows || []) {
        if (row?.[0]) dates.add(row[0])
      }
      for (const d of dates) {
        await client.query('DELETE FROM promo_daily WHERE date = $1', [d])
      }
    }
    await insertPromoRows(client, rows)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/**
 * @param {pg.Pool} db
 * @param {'shop'|'promo'} kind
 * @param {string} relPath
 * @param {number} mtimeMs
 */
export async function setMetaFile(db, kind, relPath, mtimeMs) {
  await db.query(
    `
    INSERT INTO meta_files (kind, path, mtime_ms) VALUES ($1, $2, $3)
    ON CONFLICT (kind, path) DO UPDATE SET mtime_ms = EXCLUDED.mtime_ms
  `,
    [kind, relPath, mtimeMs],
  )
}

/**
 * @param {pg.Pool} db
 * @param {'shop'|'promo'} kind
 * @param {string} relPath
 * @returns {Promise<number | null>}
 */
export async function getMetaFileMtime(db, kind, relPath) {
  const {rows} = await db.query(
    'SELECT mtime_ms FROM meta_files WHERE kind = $1 AND path = $2',
    [kind, relPath],
  )
  return rows[0] ? Number(rows[0].mtime_ms) : null
}

function mapShopRow(r) {
  return {
    date: r.date,
    shop: r.shop,
    spuid: String(r.spuid ?? ''),
    sku: String(r.sku ?? ''),
    category: String(r.category ?? ''),
    payAmount: Number(r.pay_amount) || 0,
    detailVisitors: Number(r.detail_visitors) || 0,
    favorites: Number(r.favorites) || 0,
    payUsers: Number(r.pay_users) || 0,
  }
}

/**
 * @param {pg.Pool} db
 * @param {{ start?: string|null, end?: string|null, shops?: string[] }} opts
 */
export async function queryShopRows(db, {start = null, end = null, shops = null} = {}) {
  const clauses = []
  const params = []

  if (start) {
    params.push(start)
    clauses.push(`date >= $${params.length}`)
  }
  if (end) {
    params.push(end)
    clauses.push(`date <= $${params.length}`)
  }
  if (shops?.length) {
    const startIdx = params.length + 1
    clauses.push(`shop IN (${shops.map((_, i) => `$${startIdx + i}`).join(',')})`)
    params.push(...shops)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const {rows} = await db.query(
    `
    SELECT shop, date, spuid, sku, category,
           pay_amount, detail_visitors, favorites, pay_users
    FROM shop_daily
    ${where}
    ORDER BY date, shop, spuid
  `,
    params,
  )
  return rows.map(mapShopRow)
}

/**
 * Aggregate promo by spuid within date range.
 * @param {pg.Pool} db
 * @returns {Promise<Map<string, { recommendPayAmount: number, recommendCost: number, recommendRoi: number|null }>>}
 */
export async function queryPromoAgg(db, {start = null, end = null} = {}) {
  /** @type {Map<string, { recommendPayAmount: number, recommendCost: number, recommendRoi: number|null }>} */
  const map = new Map()
  if (!start || !end) return map

  const {rows} = await db.query(
    `
    SELECT spuid,
           SUM(direct_pay) AS direct_pay,
           SUM(cost) AS cost
    FROM promo_daily
    WHERE date >= $1 AND date <= $2
    GROUP BY spuid
  `,
    [start, end],
  )

  for (const r of rows) {
    const pay = Math.round((Number(r.direct_pay) || 0) * 100) / 100
    const cost = Math.round((Number(r.cost) || 0) * 100) / 100
    map.set(String(r.spuid), {
      recommendPayAmount: pay,
      recommendCost: cost,
      recommendRoi: cost === 0 ? null : Math.round((pay / cost) * 100) / 100,
    })
  }
  return map
}

/**
 * @param {pg.Pool} db
 * @param {string} [shop]
 */
export async function listShopDatesFromDb(db, shop) {
  if (shop) {
    const {rows} = await db.query(
      'SELECT DISTINCT date FROM shop_daily WHERE shop = $1 ORDER BY date',
      [shop],
    )
    return rows.map((r) => r.date)
  }
  const {rows} = await db.query('SELECT DISTINCT date FROM shop_daily ORDER BY date')
  return rows.map((r) => r.date)
}

/**
 * @param {pg.Pool} db
 * @param {string[]} [shops]
 */
export async function listAvailableDatesFromDb(db, shops = null) {
  if (shops?.length) {
    const {rows} = await db.query(
      `
      SELECT DISTINCT date FROM shop_daily
      WHERE shop IN (${shops.map((_, i) => `$${i + 1}`).join(',')})
      ORDER BY date
    `,
      shops,
    )
    return rows.map((r) => r.date)
  }
  return listShopDatesFromDb(db)
}

/**
 * @param {pg.Pool} db
 */
export async function getMetaFromDb(db) {
  const dates = await listAvailableDatesFromDb(db)
  const bigDates = await listShopDatesFromDb(db, '大店')
  const smallDates = await listShopDatesFromDb(db, '小店')
  return {
    shops: ['大店', '小店'],
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
