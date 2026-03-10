#!/bin/bash
# ═══════════════════════════════════════════════════
#  Nokhda — Netlify Deploy Script
#  Usage: NETLIFY_TOKEN=your_token bash deploy.sh
# ═══════════════════════════════════════════════════

set -e

TOKEN="${NETLIFY_TOKEN:-$1}"

if [ -z "$TOKEN" ]; then
  echo ""
  echo "  ╔══════════════════════════════════════════╗"
  echo "  ║  Nokhda — Netlify Deploy                 ║"
  echo "  ╚══════════════════════════════════════════╝"
  echo ""
  echo "  Get your token at:"
  echo "  https://app.netlify.com/user/applications#personal-access-tokens"
  echo ""
  echo "  Then run:"
  echo "  NETLIFY_TOKEN=your_token bash deploy.sh"
  echo ""
  exit 1
fi

echo ""
echo "  ◆ Nokhda — Dubai Property Intelligence"
echo "  ◆ Deploying to Netlify..."
echo ""

# Step 1: Create a new Netlify site
SITE_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"nokhda-dubai","custom_domain":null}' \
  https://api.netlify.com/api/v1/sites)

SITE_ID=$(echo $SITE_RESPONSE | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)
SITE_URL=$(echo $SITE_RESPONSE | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ssl_url',d.get('url','')))" 2>/dev/null)

if [ -z "$SITE_ID" ]; then
  echo "  ✗ Failed to create site. Check your token."
  echo "  Response: $SITE_RESPONSE"
  exit 1
fi

echo "  ✓ Site created: $SITE_ID"
echo "  ◆ Uploading files..."

# Step 2: Deploy the zip file
DEPLOY_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary "@nokhda-deploy.zip" \
  "https://api.netlify.com/api/v1/sites/$SITE_ID/deploys")

DEPLOY_URL=$(echo $DEPLOY_RESPONSE | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ssl_url',d.get('deploy_ssl_url','')))" 2>/dev/null)
DEPLOY_ID=$(echo $DEPLOY_RESPONSE | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)

if [ -z "$DEPLOY_ID" ]; then
  echo "  ✗ Deploy failed."
  echo "  Response: $DEPLOY_RESPONSE"
  exit 1
fi

echo ""
echo "  ╔══════════════════════════════════════════════════════╗"
echo "  ║  ✓ NOKHDA IS LIVE!                                   ║"
echo "  ║                                                      ║"
echo "  ║  URL: $DEPLOY_URL"
echo "  ║                                                      ║"
echo "  ║  Netlify dashboard:                                  ║"
echo "  ║  https://app.netlify.com/sites/$SITE_ID             ║"
echo "  ╚══════════════════════════════════════════════════════╝"
echo ""
echo "  Save your Site ID for future updates: $SITE_ID"
echo ""
echo "  To update the site later:"
echo "  NETLIFY_TOKEN=your_token SITE_ID=$SITE_ID bash update.sh"
echo ""

# Save site ID for future updates
echo "$SITE_ID" > .netlify-site-id
echo "  ◆ Site ID saved to .netlify-site-id"
