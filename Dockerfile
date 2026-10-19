FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV PORT=8787 CONFIG_PATH=/data/config.json
VOLUME /data
EXPOSE 8787
CMD ["node", "src/server.js"]
