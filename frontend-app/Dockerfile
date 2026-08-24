FROM node:22-alpine

WORKDIR /app

# Install deps in their own layer so source edits don't reinstall everything.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .

EXPOSE 5173

# --host is also in the npm script; repeated here so `docker run` works directly.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
