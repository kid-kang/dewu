/**
 * 从项目根目录加载 .env（不覆盖已有环境变量）。
 * Docker / 系统环境优先；本地直接 node 启动时也能读到 DATABASE_URL。
 */
import path from 'path'
import {fileURLToPath} from 'url'
import dotenv from 'dotenv'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

dotenv.config({
  path: path.join(root, '.env'),
  // 已有环境变量（如 docker-compose）优先，不被 .env 覆盖
  override: false,
})
