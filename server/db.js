import fs from 'fs'
import path from 'path'
import {randomBytes, scryptSync, timingSafeEqual} from 'crypto'
import Database from 'better-sqlite3'

const DB_REL = path.join('data', 'dewu.sqlite')

/** @type {import('better-sqlite3').Database | null} */
let cachedDb = null
/** @type {string | null} */
let cachedRoot = null

export function dbPath(root) {
  return path.join(root, DB_REL)
}

export function openDb(root) {
  if (cachedDb && cachedRoot === root) return cachedDb

  const file = dbPath(root)
  fs.mkdirSync(path.dirname(file), {recursive: true})

  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_daily (
      shop TEXT NOT NULL,
      date TEXT NOT NULL,
      spuid TEXT NOT NULL,
      sku TEXT,
      category TEXT,
      pay_amount REAL NOT NULL DEFAULT 0,
      detail_visitors REAL NOT NULL DEFAULT 0,
      favorites REAL NOT NULL DEFAULT 0,
      pay_users REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_shop_daily_shop_date ON shop_daily(shop, date);
    CREATE INDEX IF NOT EXISTS idx_shop_daily_date_spuid ON shop_daily(date, spuid);
    CREATE INDEX IF NOT EXISTS idx_shop_daily_category ON shop_daily(category);

    CREATE TABLE IF NOT EXISTS promo_daily (
      date TEXT NOT NULL,
      spuid TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      direct_pay REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_promo_daily_date_spuid ON promo_daily(date, spuid);

    CREATE TABLE IF NOT EXISTS meta_files (
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      PRIMARY KEY (kind, path)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      name TEXT PRIMARY KEY NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  ensureDefaultAdmin(db)

  cachedDb = db
  cachedRoot = root
  return db
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
 * @param {import('better-sqlite3').Database} db
 */
function ensureDefaultAdmin(db) {
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(DEFAULT_ADMIN_USER)
  if (row) return
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
    DEFAULT_ADMIN_USER,
    hashPassword(DEFAULT_ADMIN_PASS),
  )
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} username
 */
export function findUserByUsername(db, username) {
  return db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(String(username || ''))
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 */
export function hasMigration(db, id) {
  const row = db.prepare('SELECT 1 AS ok FROM schema_migrations WHERE id = ?').get(String(id || ''))
  return Boolean(row)
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 */
export function markMigration(db, id) {
  db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(String(id || ''))
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {string[]}
 */
export function listCategoryNames(db) {
  return db.prepare('SELECT name FROM categories ORDER BY name COLLATE NOCASE').all().map((r) => String(r.name))
}

/**
 * Insert missing category full-path names. Returns newly added names.
 * @param {import('better-sqlite3').Database} db
 * @param {Iterable<string>} names
 * @returns {{ added: number, addedNames: string[] }}
 */
export function upsertCategories(db, names) {
  const ins = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)')
  /** @type {string[]} */
  const addedNames = []
  const tx = db.transaction((list) => {
    for (const raw of list) {
      const name = String(raw || '').trim()
      if (!name || /^null(-null)*$/i.test(name)) continue
      const info = ins.run(name)
      if (info.changes > 0) addedNames.push(name)
    }
  })
  tx(names || [])
  return {added: addedNames.length, addedNames}
}

/**
 * Collect DISTINCT category from shop_daily into categories table.
 * @param {import('better-sqlite3').Database} db
 */
export function collectCategoriesFromShopDaily(db) {
  const rows = db.prepare(`
    SELECT DISTINCT category AS name FROM shop_daily
    WHERE category IS NOT NULL AND TRIM(category) != ''
  `).all()
  return upsertCategories(db, rows.map((r) => r.name))
}

export function closeDb() {
  if (cachedDb) {
    try {
      cachedDb.close()
    } catch {
      /* ignore */
    }
    cachedDb = null
    cachedRoot = null
  }
}

export function dbExists(root) {
  return fs.existsSync(dbPath(root))
}

/**
 * Replace all shop rows for one shop+date.
 * @param {import('better-sqlite3').Database} db
 * @param {string} shop
 * @param {string} date
 * @param {Array<{spuid:string,sku?:string,category?:string,payAmount?:number,detailVisitors?:number,favorites?:number,payUsers?:number}>} rows
 */
export function upsertShopDay(db, shop, date, rows) {
  const del = db.prepare('DELETE FROM shop_daily WHERE shop = ? AND date = ?')
  const ins = db.prepare(`
    INSERT INTO shop_daily (
      shop, date, spuid, sku, category,
      pay_amount, detail_visitors, favorites, pay_users
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const tx = db.transaction((list) => {
    del.run(shop, date)
    for (const r of list) {
      if (!r?.spuid) continue
      ins.run(
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
  })
  tx(rows || [])
}

/**
 * Delete shop rows for one shop+date (rollback helper).
 * @param {import('better-sqlite3').Database} db
 */
export function deleteShopDay(db, shop, date) {
  db.prepare('DELETE FROM shop_daily WHERE shop = ? AND date = ?').run(shop, date)
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} start YYYYMMDD
 * @param {string} end YYYYMMDD
 */
export function deletePromoRange(db, start, end) {
  db.prepare('DELETE FROM promo_daily WHERE date >= ? AND date <= ?').run(start, end)
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} start
 * @param {string} end
 */
export function promoRangeHasData(db, start, end) {
  const row = db.prepare(
    'SELECT 1 AS ok FROM promo_daily WHERE date >= ? AND date <= ? LIMIT 1',
  ).get(start, end)
  return Boolean(row)
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'shop'|'promo'} kind
 * @param {string} relPath
 */
export function deleteMetaFile(db, kind, relPath) {
  db.prepare('DELETE FROM meta_files WHERE kind = ? AND path = ?').run(kind, relPath)
}

/**
 * Replace promo rows for a set of dates covered by one source file.
 * Prefer deleting by exact date list from the rows being inserted.
 * @param {import('better-sqlite3').Database} db
 * @param {Array<[string, string, number, number]>} rows compact [ymd, spuid, cost, directPay]
 * @param {{ start?: string, end?: string } | null} [range] optional date range to clear first
 */
export function upsertPromoRows(db, rows, range = null) {
  const delRange = db.prepare('DELETE FROM promo_daily WHERE date >= ? AND date <= ?')
  const delDate = db.prepare('DELETE FROM promo_daily WHERE date = ?')
  const ins = db.prepare(`
    INSERT INTO promo_daily (date, spuid, cost, direct_pay)
    VALUES (?, ?, ?, ?)
  `)

  const tx = db.transaction((list) => {
    if (range?.start && range?.end) {
      delRange.run(range.start, range.end)
    } else {
      const dates = new Set()
      for (const row of list) {
        if (row?.[0]) dates.add(row[0])
      }
      for (const d of dates) delDate.run(d)
    }
    for (const row of list) {
      if (!row?.[0] || !row?.[1]) continue
      ins.run(row[0], String(row[1]), Number(row[2]) || 0, Number(row[3]) || 0)
    }
  })
  tx(rows || [])
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'shop'|'promo'} kind
 * @param {string} relPath
 * @param {number} mtimeMs
 */
export function setMetaFile(db, kind, relPath, mtimeMs) {
  db.prepare(`
    INSERT INTO meta_files (kind, path, mtime_ms) VALUES (?, ?, ?)
    ON CONFLICT(kind, path) DO UPDATE SET mtime_ms = excluded.mtime_ms
  `).run(kind, relPath, mtimeMs)
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'shop'|'promo'} kind
 * @param {string} relPath
 * @returns {number | null}
 */
export function getMetaFileMtime(db, kind, relPath) {
  const row = db.prepare('SELECT mtime_ms FROM meta_files WHERE kind = ? AND path = ?').get(kind, relPath)
  return row ? Number(row.mtime_ms) : null
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
 * @param {import('better-sqlite3').Database} db
 * @param {{ start?: string|null, end?: string|null, shops?: string[] }} opts
 */
export function queryShopRows(db, {start = null, end = null, shops = null} = {}) {
  const clauses = []
  const params = []

  if (start) {
    clauses.push('date >= ?')
    params.push(start)
  }
  if (end) {
    clauses.push('date <= ?')
    params.push(end)
  }
  if (shops?.length) {
    clauses.push(`shop IN (${shops.map(() => '?').join(',')})`)
    params.push(...shops)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const stmt = db.prepare(`
    SELECT shop, date, spuid, sku, category,
           pay_amount, detail_visitors, favorites, pay_users
    FROM shop_daily
    ${where}
    ORDER BY date, shop, spuid
  `)
  return stmt.all(...params).map(mapShopRow)
}

/**
 * Aggregate promo by spuid within date range.
 * @param {import('better-sqlite3').Database} db
 * @returns {Map<string, { recommendPayAmount: number, recommendCost: number, recommendRoi: number|null }>}
 */
export function queryPromoAgg(db, {start = null, end = null} = {}) {
  /** @type {Map<string, { recommendPayAmount: number, recommendCost: number, recommendRoi: number|null }>} */
  const map = new Map()
  if (!start || !end) return map

  const rows = db.prepare(`
    SELECT spuid,
           SUM(direct_pay) AS direct_pay,
           SUM(cost) AS cost
    FROM promo_daily
    WHERE date >= ? AND date <= ?
    GROUP BY spuid
  `).all(start, end)

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
 * @param {import('better-sqlite3').Database} db
 * @param {string} [shop]
 */
export function listShopDatesFromDb(db, shop) {
  if (shop) {
    return db.prepare('SELECT DISTINCT date FROM shop_daily WHERE shop = ? ORDER BY date').all(shop).map((r) => r.date)
  }
  return db.prepare('SELECT DISTINCT date FROM shop_daily ORDER BY date').all().map((r) => r.date)
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} [shops]
 */
export function listAvailableDatesFromDb(db, shops = null) {
  if (shops?.length) {
    return db.prepare(`
      SELECT DISTINCT date FROM shop_daily
      WHERE shop IN (${shops.map(() => '?').join(',')})
      ORDER BY date
    `).all(...shops).map((r) => r.date)
  }
  return listShopDatesFromDb(db)
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function getMetaFromDb(db) {
  const dates = listAvailableDatesFromDb(db)
  const bigDates = listShopDatesFromDb(db, '大店')
  const smallDates = listShopDatesFromDb(db, '小店')
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
