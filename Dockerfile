# Node.js server voor mijnwarmevloer.nl
FROM node:20-alpine

WORKDIR /app

# Eerst alleen package files kopiëren (betere build caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Daarna de rest van de app
COPY . .

# Railway zet $PORT automatisch; de server leest die env var
EXPOSE 8080

CMD ["npm", "start"]
