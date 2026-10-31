#!/usr/bin/env bash
# Deploy the VideoGen licence server to Cloud Run in brain-3bc3a (beside, not
# inside, Snap Projects' proxy). One-time setup is in server/README.md.
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=brain-3bc3a
SERVICE=videogen-license-server
REGION=us-central1
: "${FIREBASE_WEB_API_KEY:?set FIREBASE_WEB_API_KEY (Firebase console > Project settings > Web API key)}"

npm run build

serving() { gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.latestReadyRevisionName)' 2>/dev/null || true; }
BEFORE="$(serving)"

gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars "FIRESTORE_PROJECT_ID=$PROJECT,FIREBASE_WEB_API_KEY=$FIREBASE_WEB_API_KEY" \
  --min-instances 0 \
  --max-instances 10 \
  --concurrency 40 \
  --memory 512Mi \
  --cpu-boost \
  --timeout=900 \
  --startup-probe=tcpSocket.port=8080,initialDelaySeconds=2,timeoutSeconds=5,periodSeconds=5,failureThreshold=12

gcloud run services update-traffic "$SERVICE" --project "$PROJECT" --region "$REGION" --to-latest
AFTER="$(serving)"
if [ -z "$AFTER" ] || [ "$AFTER" = "$BEFORE" ]; then
  echo >&2 "DEPLOY DID NOT LAND: still serving ${BEFORE:-<none>}. Read the new revision's logs:"
  echo >&2 "  gcloud logging read 'resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\"' --limit 30 --project $PROJECT"
  exit 1
fi
URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo "OK - serving $AFTER at $URL"
echo "Health: $(curl -s "$URL/health")"
