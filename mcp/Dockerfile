FROM node:22-slim

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY mcp/requirements.txt ./mcp/requirements.txt
RUN pip3 install --break-system-packages --no-cache-dir -r mcp/requirements.txt

COPY mcp ./mcp
COPY src ./src

ENV PYTHONPATH=/app/mcp
ENV HOMELY_MCP_HOST=0.0.0.0
ENV HOMELY_MCP_HTTP_PORT=8080
EXPOSE 8080
CMD ["python3", "/app/mcp/server.py"]
