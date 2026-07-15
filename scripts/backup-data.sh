#!/usr/bin/env bash
set -euo pipefail

# 每日备份 data 目录为 tar.zst（zstd -19）
# cron 示例：0 0 * * * /path/to/scripts/backup-data.sh >> /path/to/logs/backup.log 2>&1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${ROOT}/data"
BACKUP_DIR="${ROOT}/backups"
LOG_DIR="${ROOT}/logs"
KEEP_DAYS="${KEEP_DAYS:-7}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="${BACKUP_DIR}/data_${STAMP}.tar.zst"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

mkdir -p "${BACKUP_DIR}" "${LOG_DIR}"

if [[ ! -d "${DATA_DIR}" ]]; then
  echo "[$(date '+%F %T')] ERROR: data 目录不存在: ${DATA_DIR}" >&2
  exit 1
fi

if ! command -v zstd >/dev/null 2>&1; then
  echo "[$(date '+%F %T')] ERROR: 未找到 zstd，请先安装 (brew install zstd)" >&2
  exit 1
fi

echo "[$(date '+%F %T')] 开始备份 ${DATA_DIR} -> ${OUT}"

# 管道压缩：等级 19；-T0 自动用满可用核
tar -cf - -C "${ROOT}" data | zstd -19 -T0 -f -o "${OUT}"

SIZE="$(du -h "${OUT}" | awk '{print $1}')"
echo "[$(date '+%F %T')] 备份完成: ${OUT} (${SIZE})"

# 清理过期备份
DELETED="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'data_*.tar.zst' -mtime +"${KEEP_DAYS}" -print -delete | wc -l | tr -d ' ')"
if [[ "${DELETED}" -gt 0 ]]; then
  echo "[$(date '+%F %T')] 已清理 ${DELETED} 个超过 ${KEEP_DAYS} 天的备份"
fi
