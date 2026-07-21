FROM node:22-alpine

# Alpine 换阿里云源；sshd 给人登容器，openssh-client 给 git@github 拉代码
RUN sed -i 's#https\?://dl-cdn.alpinelinux.org#https://mirrors.aliyun.com#g' /etc/apk/repositories \
  && apk add --no-cache git openssh-server openssh-sftp-server openssh-client \
  && ssh-keygen -A \
  && mkdir -p /var/run/sshd /app /root/.ssh \
  && ssh-keyscan -t ed25519,rsa github.com >> /etc/ssh/ssh_known_hosts \
  && chmod 644 /etc/ssh/ssh_known_hosts

WORKDIR /app

# npm 使用国内镜像
RUN npm config set registry https://registry.npmmirror.com

COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; \
    elif [ -f pnpm-lock.yaml ]; then npm install -g pnpm && pnpm install --prod --frozen-lockfile; \
    else npm install --omit=dev; fi

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

COPY . .

EXPOSE 3780 22

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "--watch", "server/index.js"]
