FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm ci || npm install
COPY client/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN addgroup -S hookbox && adduser -S hookbox -G hookbox
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && (npm ci --omit=dev || npm install --omit=dev)
COPY server/ ./server/
COPY --from=client-build /app/client/dist ./client/dist
RUN mkdir -p data && chown -R hookbox:hookbox /app
USER hookbox
ENV PORT=5070
ENV HOST=0.0.0.0
ENV NODE_ENV=production
EXPOSE 5070
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5070/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.js"]
