#!/bin/bash
# Copy secrets from n8n namespace to platformportal namespace
# Run after creating the namespace

set -e

echo "Copying secrets from n8n to platformportal..."

# Copy harbor-registry (docker pull secret)
kubectl get secret harbor-registry -n n8n -o json \
  | jq 'del(.metadata.namespace,.metadata.resourceVersion,.metadata.uid,.metadata.creationTimestamp,.metadata.annotations)' \
  | jq '.metadata.namespace = "platformportal"' \
  | kubectl apply -f -

# Copy n8n-webhooks-env (Azure AD secrets)
kubectl get secret n8n-webhooks-env -n n8n -o json \
  | jq 'del(.metadata.namespace,.metadata.resourceVersion,.metadata.uid,.metadata.creationTimestamp,.metadata.annotations)' \
  | jq '.metadata.namespace = "platformportal"' \
  | kubectl apply -f -

# Copy platformportal-secrets but override database-url for dev DB
kubectl get secret platformportal-secrets -n n8n -o json \
  | jq 'del(.metadata.namespace,.metadata.resourceVersion,.metadata.uid,.metadata.creationTimestamp,.metadata.annotations)' \
  | jq '.metadata.namespace = "platformportal"' \
  | jq --arg dburl "$(echo -n 'postgresql://platformportal:CHANGE_ME_DEV_DB_PASSWORD@platformportal-postgres-dev:5432/platformportal' | base64)" \
    '.data["database-url"] = $dburl' \
  | kubectl apply -f -

echo "Secrets copied successfully."
