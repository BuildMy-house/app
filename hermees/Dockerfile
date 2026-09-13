FROM node:20-alpine

WORKDIR /workspace/hermees

# Install system dependencies
RUN apk add --no-cache \
  git \
  openssh-client \
  curl \
  bash \
  && mkdir -p /root/.ssh \
  && ssh-keyscan github.com >> /root/.ssh/known_hosts 2>/dev/null || true

# Copy package files
COPY package.json package-lock.json* pnpm-lock.yaml* ./

# Install dependencies
RUN npm install --legacy-peer-deps

# Copy source
COPY . .

# Expose dev server port
EXPOSE 3000

# Steward ACS configuration for in-container agents
ENV STEWARD_API_KEY=acs_dev_60621d2e247441a5fa2bbebd593658a1ade3205e0ca6554b5c28b8b257ff9c65
ENV STEWARD_URL=https://buildmyhouse.stewardacs.xyz/mcp/sse

# Default command: development server
CMD ["npm", "run", "dev"]
