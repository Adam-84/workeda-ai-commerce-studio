# Record the resolved image digest when preparing a release; override with node:...@sha256:... for immutable rebuilds.
ARG NODE_IMAGE=node:24.13.1-bookworm-slim
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node src/ ./src/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node skills/ ./skills/
COPY --chown=node:node .claude/agents/ ./.claude/agents/
COPY --chown=node:node tools/database-transfer.mjs tools/workers.mjs tools/worker.mjs ./tools/
RUN mkdir -p /var/lib/archipel /app/.claude/skills /app/.agents/skills \
    && chown -R node:node /var/lib/archipel /app/.claude /app/.agents /app/skills
USER node
RUN node src/skills-cli.js sync
EXPOSE 4319
STOPSIGNAL SIGTERM
CMD ["node", "src/cloud-server.js"]
