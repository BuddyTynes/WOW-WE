FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache sqlite

COPY package.json ./
COPY src ./src
COPY migrations ./migrations

ENV NODE_ENV=production
ENV WOW_LLM_BRIDGE_PORT=11434

EXPOSE 11434

CMD ["node", "src/server.js"]
