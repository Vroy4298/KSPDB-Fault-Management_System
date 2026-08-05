#!/bin/sh
# entrypoint.sh — replaces BACKEND_PLACEHOLDER in nginx config with the actual
# Render backend URL passed in via the BACKEND_URL environment variable.
set -e

: "${BACKEND_URL:?ERROR: BACKEND_URL environment variable is not set}"

# Strip trailing slash if present
BACKEND_URL="${BACKEND_URL%/}"

# Substitute placeholder in the nginx config
sed -i "s|BACKEND_PLACEHOLDER|${BACKEND_URL}|g" /etc/nginx/conf.d/default.conf

echo "[entrypoint] Backend URL set to: ${BACKEND_URL}"

# Hand off to nginx
exec nginx -g "daemon off;"
