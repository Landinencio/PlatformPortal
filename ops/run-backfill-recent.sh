#!/bin/bash
set -e

echo "=== DORA Metrics Recent Backfill ==="
echo "This will backfill snapshots for dates: 2026-03-17 to 2026-03-23"
echo ""

# Check if we're in the right cluster
CONTEXT=$(kubectl config current-context)
if [[ ! "$CONTEXT" =~ "dp-tooling" ]]; then
  echo "ERROR: Not in dp-tooling cluster. Current context: $CONTEXT"
  echo "Please run: kubectl config use-context <dp-tooling-context>"
  exit 1
fi

echo "Current cluster: $CONTEXT"
echo ""

# Option 1: Run as K8s Job (recommended)
echo "Option 1: Run as Kubernetes Job (recommended for reliability)"
echo "  kubectl apply -f ops/k8s/backfill-recent-job.yaml"
echo "  kubectl logs -n n8n -f job/dora-backfill-recent"
echo ""

# Option 2: Run inside existing pod
echo "Option 2: Run inside existing app pod"
echo "  POD=\$(kubectl get pod -n n8n -l app.kubernetes.io/name=n8n-webhooks -o jsonpath='{.items[0].metadata.name}')"
echo "  kubectl cp ops/backfill-recent.js n8n/\$POD:/tmp/backfill-recent.js"
echo "  kubectl exec -n n8n \$POD -- node /tmp/backfill-recent.js"
echo ""

# Option 3: Manual curl from local machine
echo "Option 3: Manual execution (one by one)"
echo "  for date in 2026-03-17 2026-03-18 2026-03-19 2026-03-20 2026-03-21 2026-03-22 2026-03-23; do"
echo "    echo \"Processing \$date...\""
echo "    kubectl exec -n n8n deployment/n8n-webhooks -- wget -qO- --post-data='' \"http://localhost:3000/api/metrics/snapshot-all?date=\$date\" || echo \"Failed: \$date\""
echo "    sleep 30"
echo "  done"
echo ""

read -p "Choose option (1/2/3) or press Ctrl+C to cancel: " choice

case $choice in
  1)
    echo "Launching Kubernetes Job..."
    kubectl apply -f ops/k8s/backfill-recent-job.yaml
    echo ""
    echo "Job created. Follow logs with:"
    echo "  kubectl logs -n n8n -f job/dora-backfill-recent"
    ;;
  2)
    echo "Running inside existing pod..."
    POD=$(kubectl get pod -n n8n -l app.kubernetes.io/name=n8n-webhooks -o jsonpath='{.items[0].metadata.name}')
    echo "Target pod: $POD"
    kubectl cp ops/backfill-recent.js n8n/$POD:/tmp/backfill-recent.js
    kubectl exec -n n8n $POD -- node /tmp/backfill-recent.js
    ;;
  3)
    echo "Running manual execution..."
    for date in 2026-03-17 2026-03-18 2026-03-19 2026-03-20 2026-03-21 2026-03-22 2026-03-23; do
      echo "Processing $date..."
      kubectl exec -n n8n deployment/n8n-webhooks -- wget -qO- --post-data='' "http://localhost:3000/api/metrics/snapshot-all?date=$date" || echo "Failed: $date"
      echo ""
      sleep 30
    done
    ;;
  *)
    echo "Invalid option"
    exit 1
    ;;
esac
