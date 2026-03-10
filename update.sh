#!/bin/bash
# ═══════════════════════════════════════════════════
#  Nokhda — Update existing Netlify site
#  Usage: NETLIFY_TOKEN=your_token SITE_ID=xxx bash update.sh
# ═══════════════════════════════════════════════════

TOKEN="${NETLIFY_TOKEN:-$1}"
SITE_ID="${SITE_ID:-$(cat .netlify-site-id 2>/dev/null)}"

if [ -z "$TOKEN" ] || [ -z "$SITE_ID" ]; then
  echo "Usage: NETLIFY_TOKEN=your_token SITE_ID=your_site_id bash update.sh"
  exit 1
fi

echo "  ◆ Nokhda — Pushing update..."

DEPLOY_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary "@nokhda-deploy.zip" \
  "https://api.netlify.com/api/v1/sites/$SITE_ID/deploys")

DEPLOY_URL=$(echo $DEPLOY_RESPONSE | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ssl_url',d.get('deploy_ssl_url','')))" 2>/dev/null)

echo "  ✓ Updated: $DEPLOY_URL"
