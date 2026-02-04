#!/bin/bash

# Script to test get_patient_details tool

if [ -z "$1" ]; then
  echo "Usage: ./scripts/test-patient-details.sh <PATIENT_ID>"
  echo ""
  echo "Example:"
  echo "  ./scripts/test-patient-details.sh 12345"
  exit 1
fi

PATIENT_ID=$1

echo "🧪 Testing get_patient_details with patient ID: $PATIENT_ID"
echo ""

RESPONSE=$(curl -s -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"get_patient_details\",
      \"arguments\": {
        \"patientId\": \"$PATIENT_ID\"
      }
    },
    \"id\": 1
  }")

# Check for errors
ERROR=$(echo "$RESPONSE" | jq -r '.error // empty')

if [ ! -z "$ERROR" ] && [ "$ERROR" != "null" ]; then
  echo "❌ Error occurred:"
  echo "$RESPONSE" | jq '.error'
else
  echo "✅ Success! Patient details:"
  echo ""
  echo "$RESPONSE" | jq '.result.content[0].text' | jq .
fi
