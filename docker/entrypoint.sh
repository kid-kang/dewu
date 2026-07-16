#!/bin/sh
set -eu

# 持久化 SSH 配置/主机密钥（宿主机 docker/sshd 映射进来）
if [ -d /ssh-config ]; then
  if [ -f /ssh-config/sshd_config ]; then
    cp -f /ssh-config/sshd_config /etc/ssh/sshd_config
  fi
  if [ -f /ssh-config/authorized_keys ]; then
    cp -f /ssh-config/authorized_keys /etc/ssh/authorized_keys
    chmod 644 /etc/ssh/authorized_keys
  fi
  for key in /ssh-config/ssh_host_*_key; do
    [ -f "$key" ] || continue
    base=$(basename "$key")
    cp -f "$key" "/etc/ssh/$base"
    chmod 600 "/etc/ssh/$base"
    if [ -f "${key}.pub" ]; then
      cp -f "${key}.pub" "/etc/ssh/${base}.pub"
      chmod 644 "/etc/ssh/${base}.pub"
    fi
  done
fi

mkdir -p /var/run/sshd
/usr/sbin/sshd

exec "$@"
