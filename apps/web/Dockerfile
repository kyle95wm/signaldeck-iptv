FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_PLAYBACK_MODE=hybrid
ENV VITE_PLAYBACK_MODE=${VITE_PLAYBACK_MODE}
COPY package.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm install --workspace @iptvplayer/web
COPY apps/web ./apps/web
RUN npm run build --workspace @iptvplayer/web

FROM nginx:1.27-alpine AS runner
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
