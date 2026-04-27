FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
COPY apps/server/package.json apps/server/package.json
RUN npm install --workspace @iptvplayer/server

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/package.json ./apps/server/package.json
COPY apps/server/src ./apps/server/src
EXPOSE 3001
CMD ["node", "apps/server/src/index.js"]
