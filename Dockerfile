FROM debian:bookworm

RUN apt-get update && apt-get install -y \
  nodejs npm ffmpeg chromium \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json /app/package.json
RUN npm install

COPY . /app

ENV CHROME_BIN=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

CMD ["npm", "start"]
