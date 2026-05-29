FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY src/ ./src/

EXPOSE 9090 9091

CMD ["node", "src/index.js"]
