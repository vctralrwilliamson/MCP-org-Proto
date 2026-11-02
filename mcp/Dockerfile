FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
USER node
EXPOSE 3900
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3900/health || exit 1
CMD ["node", "src/http-server.js"]
