FROM debian:bookworm

RUN apt-get update && apt-get install -y \
  nodejs npm \
  ffmpeg \
  chromium \
  ca-certificates \
  fonts-noto-color-emoji fonts-noto-cjk \
  libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
  libgbm1 libasound2 libpangocairo-1.0-0 libgtk-3-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json /app/package.json
RUN npm install

COPY . /app

ENV CHROME_BIN=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

CMD ["npm", "start"]
