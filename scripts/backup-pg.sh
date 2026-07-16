#!/usr/bin/env bash
set -euo pipefail

# 每日 pg_dump dewu 库到 backups/
# crontab 示例：
#   0 0 * * * /Users/looyeagee/project/dewu/scripts/backup-pg.sh >> /Users/looyeagee/project/dewu/logs/backup-pg.log 2>&1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${ROOT}/backups"
LOG_DIR="${ROOT}/logs"
KEEP_DAYS="${KEEP_DAYS:-7}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="${BACKUP_DIR}/dewu_${STAMP}.sql.gz"
CONTAINER="${PG_CONTAINER:-dewu-postgres}"
ENV_FILE="${ROOT}/.env"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${PATH}"

mkdir -p "${BACKUP_DIR}" "${LOG_DIR}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[$(date '+%F %T')] ERROR: 缺少 .env: ${ENV_FILE}" >&2
  exit 1
fi

# 读取 .env（只取需要的键，避免 eval 整文件）
POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "${ENV_FILE}" | head -1 | cut -d= -f2-)"
POSTGRES_DB="$(grep -E '^POSTGRES_DB=' "${ENV_FILE}" | head -1 | cut -d= -f2-)"
POSTGRES_USER="${POSTGRES_USER:-dewu}"
POSTGRES_DB="${POSTGRES_DB:-dewu}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[$(date '+%F %T')] ERROR: 未找到 docker" >&2
  exit 1
fi

if ! docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null | grep -q true; then
  echo "[$(date '+%F %T')] ERROR: 容器未运行: ${CONTAINER}" >&2
  exit 1
fi

echo "[$(date '+%F %T')] 开始 pg_dump ${POSTGRES_DB} -> ${OUT}"

docker exec -i "${CONTAINER}" \
  pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" --no-owner --no-acl \
  | gzip -c > "${OUT}"

SIZE="$(du -h "${OUT}" | awk '{print $1}')"
echo "[$(date '+%F %T')] 备份完成: ${OUT} (${SIZE})"

DELETED="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'dewu_*.sql.gz' -mtime +"${KEEP_DAYS}" -print -delete | wc -l | tr -d ' ')"
if [[ "${DELETED}" -gt 0 ]]; then
  echo "[$(date '+%F %T')] 已清理 ${DELETED} 个超过 ${KEEP_DAYS} 天的备份"
fi
