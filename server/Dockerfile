FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY dist ./dist
COPY console ./console
ENV PORT=8080
USER node
CMD ["node", "dist/index.mjs"]
