FROM node:20-bookworm-slim

WORKDIR /app

# wget is required by the docker-compose healthcheck command.
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN mkdir -p /app/data /app/logs

EXPOSE 3000

CMD ["npm", "start"]
