FROM node:22-alpine

WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server/src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    PUBLIC_DIR=/app/public \
    UPLOAD_DIR=/data/uploads

RUN mkdir -p /data/uploads && chown -R node:node /data
USER node

EXPOSE 3000
CMD ["node", "src/index.js"]
