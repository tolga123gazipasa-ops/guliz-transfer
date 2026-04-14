FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# uploads/cv klasörünü garantile
RUN mkdir -p uploads/cv

EXPOSE 3001

CMD ["node", "server.js"]
