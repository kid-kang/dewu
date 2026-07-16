/**
 * 一次性：从 shop_daily 收集全部类目名称写入 categories 表。
 * 由 server/index.js 启动时调用；靠 schema_migrations 保证只跑一次。
 */
import {
  openDb,
  hasMigration,
  markMigration,
  collectCategoriesFromShopDaily,
  listCategoryNames,
} from './db.js'

export const CATEGORIES_MIGRATION_ID = 'categories_from_shop_daily_v1'

/**
 * @param {string} root
 * @returns {{ skipped: boolean, added?: number, total?: number }}
 */
export function ensureCategoriesMigrated(root) {
  const db = openDb(root)
  if (hasMigration(db, CATEGORIES_MIGRATION_ID)) {
    return {skipped: true, total: listCategoryNames(db).length}
  }

  const result = collectCategoriesFromShopDaily(db)
  markMigration(db, CATEGORIES_MIGRATION_ID)
  const total = listCategoryNames(db).length
  console.log(
    `[migrate] 类目入库完成：新增 ${result.added}，当前共 ${total} 个（${CATEGORIES_MIGRATION_ID}）`,
  )
  return {skipped: false, added: result.added, total}
}
