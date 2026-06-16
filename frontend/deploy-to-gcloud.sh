#!/bin/bash
# Exit on error
set -e

# Default env file path; can be overridden via first argument or ENV_FILE_PATH env var
ENV_FILE="${1:-$ENV_FILE_PATH}"

if [ -f "$ENV_FILE" ]; then
    # Use a subshell or set -a to export variables while sourcing
    # This allows for variable expansion like GCLOUD_PAGE_NAME=${GCLOUD_REPO_NAME}
    set -a
    source "$ENV_FILE"
    set +a
    echo "Loaded environment variables from $ENV_FILE"
else
    echo "Error: $ENV_FILE not found."
    exit 1
fi

# Map variables for convenience and TRIM trailing spaces
PROJECT_ID=$(echo $GCLOUD_PROJECT_ID | xargs)
LOCATION=$(echo $GCLOUD_LOCATION | xargs)
REPO_NAME=$(echo $GCLOUD_REPO_NAME | xargs)
IMAGE_NAME=$(echo $GCLOUD_PAGE_NAME | xargs)

echo "Starting deployment for project: $PROJECT_ID in $LOCATION..."

# Set the account for the deployment
gcloud config set account $GCLOUD_USER_ACCOUNT

# 1. Ensure APIs are enabled
echo "Enabling required APIs..."
gcloud services enable \
    artifactregistry.googleapis.com \
    run.googleapis.com \
    secretmanager.googleapis.com \
    cloudbuild.googleapis.com \
    --project "$PROJECT_ID"

# 1b. Grant permissions to Cloud Build Service Account & Agent
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
CB_SERVICE_ACCOUNT="$PROJECT_NUMBER@cloudbuild.gserviceaccount.com"
CB_SERVICE_AGENT="service-$PROJECT_NUMBER@gcp-sa-cloudbuild.iam.gserviceaccount.com"

echo "Granting Artifact Registry Admin role to Cloud Build accounts..."
for SA in "serviceAccount:$CB_SERVICE_ACCOUNT" "serviceAccount:$CB_SERVICE_AGENT"; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="$SA" \
        --role="roles/artifactregistry.admin" \
        --quiet || echo "Warning: Could not grant permissions to $SA"
done

# Artifact Registry Setup (RECREATION)
# If the repo was created with a broken name/description, let's fix it
if gcloud artifacts repositories describe "$REPO_NAME" --location="$LOCATION" --project "$PROJECT_ID" >/dev/null 2>&1; then
    # Check if description has the broken template
    DESC=$(gcloud artifacts repositories describe "$REPO_NAME" --location="$LOCATION" --project "$PROJECT_ID" --format='value(description)')
    if [[ "$DESC" == *"${GCLOUD_REPO_NAME}"* ]]; then
        echo "Detected broken repository metadata. Deleting and recreating..."
        gcloud artifacts repositories delete "$REPO_NAME" --location="$LOCATION" --project "$PROJECT_ID" --quiet
    fi
fi

if ! gcloud artifacts repositories describe "$REPO_NAME" --location="$LOCATION" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo "Creating Artifact Registry repository $REPO_NAME..."
    gcloud artifacts repositories create "$REPO_NAME" \
        --repository-format=docker \
        --location="$LOCATION" \
        --description="$GCLOUD_DESCRIPTION" \
        --project "$PROJECT_ID"
fi

# Secret Manager Setup (only if legacy secret files exist)
# Note: Firebase config is now passed via env vars (FIREBASE_*), no secret files needed
if [ -n "$FIREBASE_ADMIN_CONFIG_PATH" ] && [ -f "$FIREBASE_ADMIN_CONFIG_PATH" ]; then
    echo "Legacy firebase-admin.json found - migrating to env vars..."
fi


# Build and Push
echo "Building and pushing Docker image..."
# Build from the root context to ensure Dockerfile can see what it needs if necessary
# However, the Dockerfile is in frontend/ and we are in frontend/
gcloud builds submit --tag "$LOCATION-docker.pkg.dev/$PROJECT_ID/$REPO_NAME/$IMAGE_NAME:latest" --project "$PROJECT_ID" .

# Deploy to Cloud Run
echo "Deploying to Cloud Run..."

# Collect all non-GCLOUD env vars to pass to Cloud Run
# This ensures things like HF_TOKEN, TRANSCRIPTION_URL_*, FIREBASE_*, etc. are included
# Note: FIREBASE_* vars now contain the config directly (no more secret files needed)
ENV_VARS_FILE="/tmp/env_vars_$(date +%s).yaml"

# List of prefixes/names for variables we want to pass
PREFIXES=("TRANSCRIPTION_URL_" "EMAILJS_" "DEFAULT_NOTIFICATION_EMAIL_" "HF_TOKEN" "DEMO" "FIREBASE_")

echo "Checking for env vars with prefixes: ${PREFIXES[*]}"

for prefix in "${PREFIXES[@]}"; do
    # Get all variables from the environment that start with the prefix
    for var in $(compgen -v "$prefix"); do
        echo "Found var: $var"
        # Write to YAML file with proper quoting for multi-line values
        # Use |- to handle multi-line strings (like private keys)
        echo "$var: |-" >> "$ENV_VARS_FILE"
        echo "${!var}" | sed 's/^/  /' >> "$ENV_VARS_FILE"
    done
done

if [ ! -f "$ENV_VARS_FILE" ]; then
    echo "Warning: No env vars file created"
elif [ ! -s "$ENV_VARS_FILE" ]; then
    echo "Warning: Env vars file is empty"
fi

# Build the gcloud run deploy command
DEPLOY_CMD="gcloud run deploy $REPO_NAME \
    --image $LOCATION-docker.pkg.dev/$PROJECT_ID/$REPO_NAME/$IMAGE_NAME:latest \
    --region $LOCATION \
    --project $PROJECT_ID \
    --platform managed \
    --allow-unauthenticated \
    --memory 4Gi --cpu 1"

# Only add env vars if we have any
if [ -f "$ENV_VARS_FILE" ] && [ -s "$ENV_VARS_FILE" ]; then
    DEPLOY_CMD="$DEPLOY_CMD --env-vars-file=$ENV_VARS_FILE"
    echo "Using env vars file: $ENV_VARS_FILE"
    cat "$ENV_VARS_FILE"
fi

echo "Running deployment..."
eval $DEPLOY_CMD

# Cleanup
rm -f "$ENV_VARS_FILE"

echo "Deployment complete!"