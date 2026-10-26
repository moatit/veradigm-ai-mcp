#!/bin/bash
# =============================================================================
# Seed AWS SSM Parameter Store with Veradigm secrets
# =============================================================================
# Usage:
#   1. Copy .env.prod.example to .env.prod and fill in real values
#   2. Run: ./scripts/setup-ssm-params.sh [--region us-east-1]
#
# This script reads .env.prod and creates SecureString parameters in SSM.
# Re-running is safe — it overwrites existing values.
# =============================================================================

set -euo pipefail

REGION="${1:-${AWS_REGION:-us-east-1}}"
PREFIX="/veradigm"
ENV_FILE=".env.prod"

if [ ! -f "${ENV_FILE}" ]; then
  echo "ERROR: ${ENV_FILE} not found. Copy .env.prod.example and fill in values."
  exit 1
fi

echo "Uploading secrets to SSM Parameter Store (region: ${REGION})..."
echo "Prefix: ${PREFIX}"
echo ""

put_param() {
  local ssm_name="$1"
  local value="$2"
  local description="${3:-}"

  if [ -z "${value}" ]; then
    echo "  SKIP: ${ssm_name} (empty value)"
    return
  fi

  aws ssm put-parameter \
    --name "${PREFIX}/${ssm_name}" \
    --value "${value}" \
    --type "SecureString" \
    --overwrite \
    --description "${description}" \
    --region "${REGION}" \
    --no-cli-pager > /dev/null

  echo "  OK: ${PREFIX}/${ssm_name}"
}

# Source the env file
set -a
source "${ENV_FILE}"
set +a

echo "--- AWS ---"
put_param "aws/account-id"           "${AWS_ACCOUNT_ID:-}"            "AWS Account ID"
put_param "aws/region"               "${AWS_REGION:-${REGION}}"       "AWS Region"

echo "--- FHIR MCP ---"
put_param "fhir/client-id"           "${CLIENT_ID:-}"                 "FHIR OAuth Client ID"
put_param "fhir/client-secret"       "${CLIENT_SECRET:-}"             "FHIR OAuth Client Secret"
put_param "fhir/base-url-sandbox"    "${FHIR_BASE_URL_SANDBOX:-}"     "FHIR Base URL (Sandbox)"
put_param "fhir/base-url-production" "${FHIR_BASE_URL_PRODUCTION:-}"  "FHIR Base URL (Production)"
put_param "fhir/auth-url-sandbox"    "${AUTH_URL_SANDBOX:-}"          "FHIR Auth URL (Sandbox)"
put_param "fhir/token-url-sandbox"   "${TOKEN_URL_SANDBOX:-}"         "FHIR Token URL (Sandbox)"
put_param "fhir/auth-url-production" "${AUTH_URL_PRODUCTION:-}"       "FHIR Auth URL (Production)"
put_param "fhir/token-url-production" "${TOKEN_URL_PRODUCTION:-}"     "FHIR Token URL (Production)"
put_param "fhir/token-cache-ttl"     "${TOKEN_CACHE_TTL:-3600}"       "Token cache TTL (seconds)"
put_param "fhir/cache-enabled"       "${CACHE_ENABLED:-true}"         "Enable token caching"
put_param "fhir/log-level"           "${LOG_LEVEL:-info}"             "Log level"

echo "--- Unity MCP ---"
put_param "unity/app-name"           "${UNITY_APP_NAME:-}"            "Unity Application Name"
put_param "unity/svc-username"       "${UNITY_SVC_USERNAME:-}"        "Unity Service Username"
put_param "unity/svc-password"       "${UNITY_SVC_PASSWORD:-}"        "Unity Service Password"
put_param "unity/ehr-username"       "${UNITY_EHR_USERNAME:-}"        "Unity EHR Username"
put_param "unity/ehr-password"       "${UNITY_EHR_PASSWORD:-}"        "Unity EHR Password"
put_param "unity/ubiquity-endpoint"  "${UNITY_UBIQUITY_ENDPOINT:-}"   "Unity Ubiquity Endpoint"
put_param "unity/ubiquity-id-pm"     "${UNITY_UBIQUITY_ID_PM:-}"      "Unity Ubiquity ID (PM)"
put_param "unity/ubiquity-id-ehr"    "${UNITY_UBIQUITY_ID_EHR:-}"     "Unity Ubiquity ID (EHR)"
put_param "unity/token-cache-ttl"    "${UNITY_TOKEN_CACHE_TTL:-1140}" "Unity token cache TTL"
put_param "unity/token-refresh-buffer" "${UNITY_TOKEN_REFRESH_BUFFER:-60}" "Unity token refresh buffer"
put_param "unity/task-type"          "${UNITY_TASK_TYPE:-}"           "Veradigm EHR task type for staff tasks"
put_param "unity/task-target"        "${UNITY_TASK_TARGET:-}"         "Veradigm EHR user or team for staff tasks"
put_param "unity/pm-share-ehr-login" "${UNITY_PM_SHARE_EHR_LOGIN:-}"  "PM signs in with the EHR user (true/false)"
put_param "unity/pm-username"        "${UNITY_PM_USERNAME:-}"         "Unity PM Username"
put_param "unity/pm-password"        "${UNITY_PM_PASSWORD:-}"         "Unity PM Password"

echo "--- Drawbridge ---"
put_param "drawbridge/tool-key"      "${DRAWBRIDGE_TOOL_KEY:-}"       "Tool route key"
put_param "drawbridge/agent-key"     "${DRAWBRIDGE_AGENT_KEY:-}"      "Phone agent key (/api/retell)"
put_param "drawbridge/session-secret" "${DRAWBRIDGE_SESSION_SECRET:-}" "Staff app session secret"
put_param "drawbridge/users-file"    "${DRAWBRIDGE_USERS_FILE:-}"     "Staff users file path in the container"
put_param "drawbridge/trust-proxy"   "${DRAWBRIDGE_TRUST_PROXY:-1}"   "Proxy hops in front of the app (nginx)"
put_param "drawbridge/fhir-rest-routes" "${DRAWBRIDGE_FHIR_REST_ROUTES:-off}" "FHIR REST/test routes"
put_param "drawbridge/public-url"    "${DRAWBRIDGE_PUBLIC_URL:-}"     "Public base URL of the staff app"
put_param "retell/webhook-api-key"   "${RETELL_WEBHOOK_API_KEY:-}"    "Retell webhook-badged API key"
put_param "clinic/timezone"          "${CLINIC_TIMEZONE:-}"           "Clinic time zone (IANA)"
put_param "intake/filing"            "${INTAKE_FILING:-}"             "Document filing switch (off by default)"
put_param "intake/save-document-format-confirmed" "${INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED:-}" "SaveScanDocument format confirmed"
put_param "intake/match-rule"        "${INTAKE_MATCH_RULE:-}"         "Document patient match rule"
put_param "intake/review-user"       "${INTAKE_REVIEW_USER:-}"        "Veradigm EHR reviewer for intake tasks"

echo "--- On-call notebook ---"
put_param "oncall/username"          "${ONCALL_USERNAME:-}"           "On-call notebook username"
put_param "oncall/password"          "${ONCALL_PASSWORD:-}"           "On-call notebook password"
put_param "oncall/session-secret"    "${ONCALL_SESSION_SECRET:-}"     "On-call notebook session secret"
put_param "oncall/clinic-hours"      "${CLINIC_HOURS:-}"              "Clinic hours"
put_param "oncall/alert-to"          "${ONCALL_ALERT_TO:-}"           "On-call alert recipient"

echo "--- Admin Portal ---"
put_param "admin/db-password"        "${DB_PASSWORD:-veradigm2026}"   "PostgreSQL password for Docker container"
put_param "admin/nextauth-url"       "${NEXTAUTH_URL:-}"              "NextAuth callback URL"
put_param "admin/nextauth-secret"    "${NEXTAUTH_SECRET:-}"           "NextAuth JWT secret"
put_param "admin/email"              "${ADMIN_EMAIL:-}"               "Admin portal email"
put_param "admin/password"           "${ADMIN_PASSWORD:-}"            "Admin portal password"
put_param "admin/api-key"            "${ADMIN_API_KEY:-}"             "API key for MCP server logging"

echo ""
echo "Done! All secrets uploaded to SSM Parameter Store."
echo "The EC2 instance will pull these at startup via fetch-secrets.sh"
