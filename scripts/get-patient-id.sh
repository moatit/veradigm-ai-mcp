#!/bin/bash

# Script to get a patient ID for testing

echo "🔍 Searching for patients..."
echo ""

# Search for a patient
RESPONSE=$(curl -s -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "search_patient",
      "arguments": {
        "firstName": "John",
        "lastName": "Doe"
      }
    },
    "id": 1
  }')

# Extract patient ID
PATIENT_ID=$(echo "$RESPONSE" | jq -r '.result.content[0].text' | jq -r '.patients[0].id // empty')

if [ -z "$PATIENT_ID" ] || [ "$PATIENT_ID" = "null" ]; then
  echo "❌ No patient found. Try different search criteria."
  echo ""
  echo "Full response:"
  echo "$RESPONSE" | jq .
else
  echo "✅ Found patient ID: $PATIENT_ID"
  echo ""
  echo "Use this ID in your RetellAI MCP node configuration:"
  echo ""
  echo "Arguments:"
  echo "{"
  echo "  \"patientId\": \"$PATIENT_ID\""
  echo "}"
fi
