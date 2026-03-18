#!/bin/bash
# Tailnow Publisher Client - Send a static folder to your Tailscale server

if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <server-url> <project-name> <directory-to-publish>"
    echo "Example: $0 http://selenes-mac-mini:8080 my-site ./dist"
    exit 1
fi

SERVER_URL=$1
PROJECT_NAME=$2
PUBLISH_DIR=$3

# Ensure directory exists
if [ ! -d "$PUBLISH_DIR" ]; then
    echo "Error: Directory '$PUBLISH_DIR' does not exist."
    exit 1
fi

# Ensure curl and zip are installed
if ! command -v curl &> /dev/null || ! command -v zip &> /dev/null; then
    echo "Error: curl and zip are required to run this script."
    exit 1
fi

# Create a temporary zip file
TMP_ZIP=$(mktemp /tmp/tailnow-XXXXXX.zip)

echo "📦 Zipping $PUBLISH_DIR..."
(cd "$PUBLISH_DIR" && zip -r -q "$TMP_ZIP" .)

echo "🚀 Publishing to $SERVER_URL/api/publish/$PROJECT_NAME..."

# Upload via curl
HTTP_RESPONSE=$(curl -s -w "%{http_code}" -X POST -F "file=@$TMP_ZIP" "$SERVER_URL/api/publish/$PROJECT_NAME")

# Extract the body and status code
HTTP_BODY=$(echo "$HTTP_RESPONSE" | sed -e 's/...$//')
HTTP_STATUS=$(echo "$HTTP_RESPONSE" | awk '{print substr($0,length,3)}')

# Clean up the zip file
rm "$TMP_ZIP"

if [ "$HTTP_STATUS" -eq 200 ]; then
    echo "✅ Success!"
    echo "$HTTP_BODY"
else
    echo "❌ Failed (Status $HTTP_STATUS)"
    echo "$HTTP_BODY"
fi
