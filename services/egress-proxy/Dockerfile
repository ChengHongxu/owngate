FROM node:24-slim

WORKDIR /proxy

COPY services/egress-proxy/package.json .
COPY services/egress-proxy/src/ ./src/

EXPOSE 3128

USER 1000:1000

CMD ["node", "src/main.js"]
