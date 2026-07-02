# Jungle agent-runner image. Build the TS outside (npm run build) so dist/ exists,
# then this COPYs it in. Runs as unprivileged user `agent`; entrypoint fixes
# /workspace ownership as root then drops privileges via gosu.
FROM node:22-slim

# System deps: git + gh CLI + ripgrep + curl/ca-certs + procps + gosu.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git curl ca-certificates ripgrep procps gnupg gosu \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Unprivileged runtime user.
RUN useradd --uid 1001 --create-home --shell /bin/bash agent

# Claude Code refuses bypassPermissions as root without this; we run as `agent`
# anyway (belt and suspenders).
ENV IS_SANDBOX=1
ENV NODE_ENV=production

WORKDIR /app

# Install production deps first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code (built outside via `npm run build`).
COPY dist ./dist

# Entrypoint fixes volume ownership then drops to `agent`.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/workspace"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "/app/dist/index.js"]
