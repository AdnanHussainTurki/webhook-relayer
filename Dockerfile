FROM node:20-alpine

WORKDIR /usr/src/app

# Install dependencies first
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src ./src
COPY .env.example ./.env.example

# Use non-root user
USER node

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/server.js"]

