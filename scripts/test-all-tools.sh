#!/bin/bash

# Test All 21 MCP Tools
# Usage: ./scripts/test-all-tools.sh

BASE_URL="http://localhost:3000"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🧪 Testing All 21 MCP Tools...${NC}\n"

# Replace these with actual IDs from your system
PATIENT_ID="patient-123"
APPOINTMENT_ID="appointment-456"
PROVIDER_ID="practitioner-789"
LOCATION_ID="location-101"

# Function to test a tool
test_tool() {
    local tool_name=$1
    local arguments=$2
    local test_num=$3
    
    echo -e "${GREEN}Test $test_num: $tool_name${NC}"
    curl -s -X POST $BASE_URL/ \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"$tool_name\",\"arguments\":$arguments},\"id\":$test_num}" \
        | jq '.' 2>/dev/null || echo "Error or jq not installed"
    echo -e "\n"
}

# Patient Tools
test_tool "search_patient" '{"firstName":"John","lastName":"Smith"}' 1
test_tool "get_patient_details" "{\"patientId\":\"$PATIENT_ID\"}" 2
test_tool "verify_patient_identity" '{"firstName":"John","lastName":"Smith","birthDate":"1990-01-15"}' 3

# Appointment Tools
test_tool "get_upcoming_appointments" "{\"patientId\":\"$PATIENT_ID\"}" 4
test_tool "get_appointment_details" "{\"appointmentId\":\"$APPOINTMENT_ID\"}" 5
test_tool "check_appointment_status" "{\"appointmentId\":\"$APPOINTMENT_ID\"}" 6
test_tool "find_patient_next_appointment" "{\"patientId\":\"$PATIENT_ID\"}" 7
test_tool "get_appointments_by_date_range" '{"startDate":"2024-03-01","endDate":"2024-03-31"}' 8

# Medication Tools
test_tool "get_patient_medications" "{\"patientId\":\"$PATIENT_ID\"}" 9
test_tool "get_medication_requests" "{\"patientId\":\"$PATIENT_ID\"}" 10
test_tool "check_refill_status" "{\"patientId\":\"$PATIENT_ID\"}" 11
test_tool "get_medication_statements" "{\"patientId\":\"$PATIENT_ID\"}" 12

# Provider Tools
test_tool "search_providers" '{"specialty":"Cardiology"}' 13
test_tool "get_provider_details" "{\"providerId\":\"$PROVIDER_ID\"}" 14
test_tool "search_locations" '{"type":"hospital"}' 15
test_tool "get_location_details" "{\"locationId\":\"$LOCATION_ID\"}" 16

# Clinical Tools
test_tool "get_patient_conditions" "{\"patientId\":\"$PATIENT_ID\"}" 17
test_tool "get_allergies" "{\"patientId\":\"$PATIENT_ID\"}" 18
test_tool "get_recent_observations" "{\"patientId\":\"$PATIENT_ID\"}" 19
test_tool "get_patient_procedures" "{\"patientId\":\"$PATIENT_ID\"}" 20
test_tool "get_patient_coverage" "{\"patientId\":\"$PATIENT_ID\"}" 21

echo -e "${GREEN}✅ All 21 tools tested!${NC}"


