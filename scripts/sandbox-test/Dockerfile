FROM mcr.microsoft.com/playwright:v1.64.1-noble

RUN apt-get update && apt-get install -y --no-install-recommends \
    zbar-tools \
    x11-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /test
COPY package.json .
COPY test.mjs .
COPY b2-qr.mjs .
COPY xvfb-wrap.sh .
RUN chmod +x xvfb-wrap.sh

RUN npm install --no-save @playwright/test 2>/dev/null; \
    npm install --no-save playwright 2>/dev/null; \
    true
