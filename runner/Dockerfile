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

# Headless Chromium + its system libs + fonts, shared at a world-readable path so the
# unprivileged agent can drive it via playwright/playwright-core. Agents building web
# apps need screenshots constantly; without this one agent spent 15 minutes hand-
# extracting 30 .debs into an LD_LIBRARY_PATH prefix (no root, no apt at runtime).
# If a project pins a different playwright version it just downloads its own browser
# build — the system libs baked here are what make that work.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx -y playwright@latest install --with-deps chromium \
  && chmod -R a+rX /ms-playwright \
  && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache

# Unprivileged runtime user.
RUN useradd --uid 1001 --create-home --shell /bin/bash agent

# Claude Code refuses bypassPermissions as root without this; we run as `agent`
# anyway (belt and suspenders). NOTE: deliberately no NODE_ENV=production — the agent's
# child processes inherit this env, and production mode breaks `npm install` of
# devDependencies in agent workspaces (the runner strips it too; see childEnv()).
ENV IS_SANDBOX=1

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
