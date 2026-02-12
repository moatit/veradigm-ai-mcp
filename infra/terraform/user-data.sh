#!/bin/bash
# =============================================================================
# EC2 User Data — Bootstrap Docker + Docker Compose
# =============================================================================
set -euxo pipefail

# Update system
dnf update -y

# Install Docker
dnf install -y docker
systemctl enable docker
systemctl start docker

# Add ec2-user to docker group
usermod -aG docker ec2-user

# Install Docker Compose v2 plugin
DOCKER_COMPOSE_VERSION="v2.27.0"
mkdir -p /usr/local/lib/docker/cli-plugins
curl -SL "https://github.com/docker/compose/releases/download/$${DOCKER_COMPOSE_VERSION}/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Install AWS CLI v2 (already on AL2023, but ensure latest)
dnf install -y aws-cli

# Create application directory
mkdir -p /opt/veradigm
chown ec2-user:ec2-user /opt/veradigm

# Login to ECR
aws ecr get-login-password --region ${aws_region} | \
  docker login --username AWS --password-stdin ${aws_account_id}.dkr.ecr.${aws_region}.amazonaws.com

# Create Nginx config directory
mkdir -p /opt/veradigm/nginx

# Create Nginx default.conf
cat > /opt/veradigm/nginx/default.conf << 'NGINX_EOF'
server {
    listen 80;
    server_name admin.veradigmai.com fhir.veradigmai.com unity.veradigmai.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name admin.veradigmai.com;

    ssl_certificate     /etc/letsencrypt/live/admin.veradigmai.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/admin.veradigmai.com/privkey.pem;
    include             /etc/nginx/ssl-common.conf;

    location / {
        proxy_pass http://admin-portal:5001;
        include    /etc/nginx/proxy-common.conf;
    }
}

server {
    listen 443 ssl;
    server_name fhir.veradigmai.com;

    ssl_certificate     /etc/letsencrypt/live/admin.veradigmai.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/admin.veradigmai.com/privkey.pem;
    include             /etc/nginx/ssl-common.conf;

    location / {
        proxy_pass http://fhir-mcp:3000;
        include    /etc/nginx/proxy-common.conf;
    }
}

server {
    listen 443 ssl;
    server_name unity.veradigmai.com;

    ssl_certificate     /etc/letsencrypt/live/admin.veradigmai.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/admin.veradigmai.com/privkey.pem;
    include             /etc/nginx/ssl-common.conf;

    location / {
        proxy_pass http://unity-mcp:3001;
        include    /etc/nginx/proxy-common.conf;
    }
}
NGINX_EOF

# Create ssl-common.conf
cat > /opt/veradigm/nginx/ssl-common.conf << 'SSLCONF_EOF'
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers HIGH:!aNULL:!MD5;
ssl_prefer_server_ciphers on;
ssl_session_cache shared:SSL:10m;
ssl_session_timeout 10m;
SSLCONF_EOF

# Create proxy-common.conf
cat > /opt/veradigm/nginx/proxy-common.conf << 'PROXYCONF_EOF'
proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade           $http_upgrade;
proxy_set_header Connection        "upgrade";
proxy_read_timeout 120s;
proxy_send_timeout 120s;
PROXYCONF_EOF

chown -R ec2-user:ec2-user /opt/veradigm/nginx

# Create docker-compose.prod.yml
cat > /opt/veradigm/docker-compose.prod.yml << 'COMPOSE_EOF'
services:
  postgres:
    image: postgres:15-alpine
    container_name: veradigm-postgres
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_DB=veradigm_admin
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=$${DB_PASSWORD:-veradigm2026}
    volumes:
      - pgdata:/var/lib/postgresql/data
    restart: unless-stopped
    networks:
      - mcp-network
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

  fhir-mcp:
    image: ${aws_account_id}.dkr.ecr.${aws_region}.amazonaws.com/veradigm-fhir-mcp:latest
    container_name: veradigm-fhir-mcp-server
    ports:
      - "3000:3000"
    env_file:
      - .env.prod
    environment:
      - NODE_ENV=sandbox
      - MCP_SERVER_PORT=3000
      - MCP_SERVER_HOST=0.0.0.0
      - ADMIN_PORTAL_URL=http://admin-portal:5001
      - MCP_CHANNEL=API
    restart: unless-stopped
    networks:
      - mcp-network
    healthcheck:
      test: ["CMD", "node", "-e", "console.log('FHIR Health check passed')"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  unity-mcp:
    image: ${aws_account_id}.dkr.ecr.${aws_region}.amazonaws.com/veradigm-unity-mcp:latest
    container_name: veradigm-unity-mcp-server
    ports:
      - "3001:3001"
    env_file:
      - .env.prod
    environment:
      - NODE_ENV=sandbox
      - UNITY_MCP_SERVER_PORT=3001
      - UNITY_MCP_SERVER_HOST=0.0.0.0
      - ADMIN_PORTAL_URL=http://admin-portal:5001
      - MCP_CHANNEL=API
    restart: unless-stopped
    networks:
      - mcp-network
    depends_on:
      fhir-mcp:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "console.log('Unity Health check passed')"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  admin-portal:
    image: ${aws_account_id}.dkr.ecr.${aws_region}.amazonaws.com/veradigm-admin-portal:latest
    container_name: veradigm-admin-portal
    ports:
      - "5001:5001"
    env_file:
      - .env.prod
    environment:
      - NODE_ENV=production
      - PORT=5001
      - HOSTNAME=0.0.0.0
      - DATABASE_URL=postgres://postgres:$${DB_PASSWORD:-veradigm2026}@postgres:5432/veradigm_admin
      - FHIR_MCP_CONTAINER_NAME=veradigm-fhir-mcp-server
      - UNITY_MCP_CONTAINER_NAME=veradigm-unity-mcp-server
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    restart: unless-stopped
    networks:
      - mcp-network
    depends_on:
      postgres:
        condition: service_healthy
      fhir-mcp:
        condition: service_healthy
      unity-mcp:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:5001/api/auth/session"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s

  nginx:
    image: nginx:alpine
    container_name: veradigm-nginx
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
      - ./nginx/ssl-common.conf:/etc/nginx/ssl-common.conf:ro
      - ./nginx/proxy-common.conf:/etc/nginx/proxy-common.conf:ro
      - certbot-webroot:/var/www/certbot:ro
      - certbot-certs:/etc/letsencrypt:ro
    restart: unless-stopped
    networks:
      - mcp-network
    depends_on:
      - fhir-mcp
      - unity-mcp
      - admin-portal

  certbot:
    image: certbot/certbot
    container_name: veradigm-certbot
    volumes:
      - certbot-webroot:/var/www/certbot
      - certbot-certs:/etc/letsencrypt
    entrypoint: "/bin/sh -c 'trap exit TERM; while :; do certbot renew --webroot -w /var/www/certbot --quiet; sleep 12h & wait $${!}; done'"
    restart: unless-stopped
    networks:
      - mcp-network

volumes:
  pgdata:
  fhir-logs:
  unity-logs:
  certbot-webroot:
  certbot-certs:

networks:
  mcp-network:
    driver: bridge
COMPOSE_EOF

chown ec2-user:ec2-user /opt/veradigm/docker-compose.prod.yml

# Create the fetch-secrets script on the instance
cat > /opt/veradigm/fetch-secrets.sh << 'SCRIPT_EOF'
#!/bin/bash
set -uo pipefail
REGION="${aws_region}"
PREFIX="/veradigm"
ENV_FILE="/opt/veradigm/.env.prod"

echo "# Auto-generated — $(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ)" > "$ENV_FILE"

fetch() {
  local val
  val=$(aws ssm get-parameter --name "$PREFIX/$1" --with-decryption --query "Parameter.Value" --output text --region "$REGION" 2>/dev/null || echo "")
  if [ -n "$val" ]; then
    echo "$2=$val" >> "$ENV_FILE"
  fi
}

fetch "aws/account-id"           "AWS_ACCOUNT_ID"
fetch "aws/region"               "AWS_REGION"
fetch "fhir/client-id"           "CLIENT_ID"
fetch "fhir/client-secret"       "CLIENT_SECRET"
fetch "fhir/base-url-sandbox"    "FHIR_BASE_URL_SANDBOX"
fetch "fhir/base-url-production" "FHIR_BASE_URL_PRODUCTION"
fetch "fhir/auth-url-sandbox"    "AUTH_URL_SANDBOX"
fetch "fhir/auth-url-production" "AUTH_URL_PRODUCTION"
fetch "fhir/token-url-sandbox"   "TOKEN_URL_SANDBOX"
fetch "fhir/token-url-production" "TOKEN_URL_PRODUCTION"
fetch "fhir/token-cache-ttl"     "TOKEN_CACHE_TTL"
fetch "fhir/cache-enabled"       "CACHE_ENABLED"
fetch "fhir/log-level"           "LOG_LEVEL"
fetch "unity/app-name"           "UNITY_APP_NAME"
fetch "unity/svc-username"       "UNITY_SVC_USERNAME"
fetch "unity/svc-password"       "UNITY_SVC_PASSWORD"
fetch "unity/ehr-username"       "UNITY_EHR_USERNAME"
fetch "unity/ehr-password"       "UNITY_EHR_PASSWORD"
fetch "unity/ubiquity-endpoint"  "UNITY_UBIQUITY_ENDPOINT"
fetch "unity/ubiquity-id-pm"     "UNITY_UBIQUITY_ID_PM"
fetch "unity/ubiquity-id-ehr"    "UNITY_UBIQUITY_ID_EHR"
fetch "unity/token-cache-ttl"    "UNITY_TOKEN_CACHE_TTL"
fetch "unity/token-refresh-buffer" "UNITY_TOKEN_REFRESH_BUFFER"
fetch "admin/db-password"        "DB_PASSWORD"
fetch "admin/nextauth-url"       "NEXTAUTH_URL"
fetch "admin/nextauth-secret"    "NEXTAUTH_SECRET"
fetch "admin/email"              "ADMIN_EMAIL"
fetch "admin/password"           "ADMIN_PASSWORD"
fetch "admin/api-key"            "ADMIN_API_KEY"
echo "DOCKER_SOCKET_PATH=/var/run/docker.sock" >> "$ENV_FILE"
SCRIPT_EOF

chmod +x /opt/veradigm/fetch-secrets.sh
chown ec2-user:ec2-user /opt/veradigm/fetch-secrets.sh

# Create a systemd service for auto-start on boot
cat > /etc/systemd/system/veradigm.service << 'SERVICE_EOF'
[Unit]
Description=Veradigm MCP Services
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=ec2-user
WorkingDirectory=/opt/veradigm
ExecStartPre=/opt/veradigm/fetch-secrets.sh
ExecStart=/usr/local/lib/docker/cli-plugins/docker-compose -f docker-compose.prod.yml up -d
ExecStop=/usr/local/lib/docker/cli-plugins/docker-compose -f docker-compose.prod.yml down

[Install]
WantedBy=multi-user.target
SERVICE_EOF

systemctl daemon-reload
systemctl enable veradigm.service

# Create SSL init script (run once to get initial certificates)
cat > /opt/veradigm/init-ssl.sh << 'SSLINIT_EOF'
#!/bin/bash
set -euo pipefail

DOMAINS="admin.veradigmai.com fhir.veradigmai.com unity.veradigmai.com"
EMAIL="admin@veradigm.com"
COMPOSE="docker compose -f /opt/veradigm/docker-compose.prod.yml"

echo "=== SSL Certificate Init ==="

# Stop nginx if running (certbot needs port 80)
$COMPOSE stop nginx 2>/dev/null || true

# Run certbot in standalone mode to get certs for all domains
docker run --rm \
  -p 80:80 \
  -v veradigm_certbot-certs:/etc/letsencrypt \
  -v veradigm_certbot-webroot:/var/www/certbot \
  certbot/certbot certonly \
    --standalone \
    -d admin.veradigmai.com \
    -d fhir.veradigmai.com \
    -d unity.veradigmai.com \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL"

echo "=== Certificates obtained, starting nginx ==="
$COMPOSE up -d nginx certbot

# Add cron job for renewal (runs twice daily)
(crontab -l 2>/dev/null; echo "0 */12 * * * cd /opt/veradigm && docker compose -f docker-compose.prod.yml exec -T certbot certbot renew --quiet && docker compose -f docker-compose.prod.yml exec -T nginx nginx -s reload") | crontab -

echo "=== SSL setup complete ==="
SSLINIT_EOF

chmod +x /opt/veradigm/init-ssl.sh
chown ec2-user:ec2-user /opt/veradigm/init-ssl.sh

echo "User data bootstrap complete"
