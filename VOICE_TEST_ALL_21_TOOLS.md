# 🎤 Voice Agent Testing Guide - All 21 Tools

## 🚀 Pre-Testing Checklist

### ✅ Step 1: Start MCP Server

```bash
# Terminal में run करें:
npm run dev
# या
npm start
```

**Expected Output:**
```
🚀 MCP Server running on http://localhost:3000
✅ All 21 tools registered successfully
```

---

### ✅ Step 2: Start Cloudflare Tunnel (if needed)

अगर RetellAI को local server access करना है:

```bash
# Cloudflare tunnel start करें
cloudflared tunnel --url http://localhost:3000
```

**Note:** Tunnel URL को RetellAI में MCP server URL के रूप में add करें।

---

### ✅ Step 3: Verify RetellAI Configuration

1. **RetellAI Dashboard** → Your Agent
2. **MCP Tools** → सभी 21 tools selected होने चाहिए
3. **Global Prompt** → `AGENT_PROMPT_FINAL.md` से copy किया गया हो
4. **Welcome Message** → Set हो
5. **AI Speaks First** → Enabled हो

---

## 🎯 Testing All 21 Tools - Natural Language Phrases

### 📋 Test Flow Overview

1. **First**: Patient search करें (tool #1)
2. **Then**: Patient ID लेकर बाकी tools test करें
3. **Finally**: Provider और Location tools test करें (patient ID की जरूरत नहीं)

---

## 👤 Patient Tools (3 tools)

### Tool 1: `search_patient`

**Test Phrases:**

1. "I want to check my information"
2. "Can you find my record?"
3. "My name is John Smith"
4. "Search for patient with MRN 32140"
5. "Find patient Amanda Smith"
6. "Look up patient by phone number 555-1234"

**Expected Behavior:**
- Agent पहले name और verification info मांगेगा
- फिर `search_patient` tool use करेगा
- Results return करेगा

---

### Tool 2: `get_patient_details`

**Test Phrases:**

1. "Show me my full patient details"
2. "What's my complete patient information?"
3. "Get all my patient records"
4. "Can you show me my patient profile?"

**Expected Behavior:**
- Agent `get_patient_details` tool use करेगा
- Complete patient information return करेगा

---

### Tool 3: `verify_patient_identity`

**Test Phrases:**

1. "Verify my identity"
2. "Can you confirm who I am?"
3. "Check if I'm the right patient"
4. "Verify my patient information"

**Expected Behavior:**
- Agent `verify_patient_identity` tool use करेगा
- Identity verification result return करेगा

---

## 📅 Appointment Tools (5 tools)

### Tool 4: `get_upcoming_appointments`

**Test Phrases:**

1. "What are my upcoming appointments?"
2. "Show me my scheduled appointments"
3. "When are my next appointments?"
4. "List all my upcoming appointments"
5. "What appointments do I have coming up?"

**Expected Behavior:**
- Agent `get_upcoming_appointments` tool use करेगा
- Upcoming appointments list return करेगा

---

### Tool 5: `get_appointment_details`

**Test Phrases:**

1. "Tell me about appointment ID [appointment-id]"
2. "What are the details of my appointment?"
3. "Show me details for appointment [id]"
4. "Get information about appointment [id]"

**Note:** आपको पहले एक appointment ID चाहिए (tool #4 से मिल सकता है)

**Expected Behavior:**
- Agent `get_appointment_details` tool use करेगा
- Specific appointment details return करेगा

---

### Tool 6: `check_appointment_status`

**Test Phrases:**

1. "What's the status of appointment [id]?"
2. "Check if my appointment is confirmed"
3. "Is appointment [id] still scheduled?"
4. "What's the current status of my appointment?"

**Note:** आपको appointment ID चाहिए

**Expected Behavior:**
- Agent `check_appointment_status` tool use करेगा
- Appointment status return करेगा

---

### Tool 7: `find_patient_next_appointment`

**Test Phrases:**

1. "When is my next appointment?"
2. "What's my next scheduled appointment?"
3. "Find my next appointment"
4. "When do I see the doctor next?"
5. "Show me my next appointment"

**Expected Behavior:**
- Agent `find_patient_next_appointment` tool use करेगा
- Next appointment details return करेगा

---

### Tool 8: `get_appointments_by_date_range`

**Test Phrases:**

1. "Show me appointments between March 1st and March 31st"
2. "What appointments do I have in March?"
3. "Get my appointments from next week"
4. "List appointments from March 1 to March 15"
5. "Show appointments in the next two weeks"

**Expected Behavior:**
- Agent `get_appointments_by_date_range` tool use करेगा
- Date range में appointments return करेगा

---

## 💊 Medication Tools (4 tools)

### Tool 9: `get_patient_medications`

**Test Phrases:**

1. "What medications am I currently taking?"
2. "Show me my current medications"
3. "List all my medications"
4. "What medicines am I on?"
5. "Get my medication list"

**Expected Behavior:**
- Agent `get_patient_medications` tool use करेगा
- Active medications list return करेगा

---

### Tool 10: `get_medication_requests`

**Test Phrases:**

1. "Show me my medication requests"
2. "What medication requests do I have?"
3. "List my medication prescriptions"
4. "Get my medication requests"

**Expected Behavior:**
- Agent `get_medication_requests` tool use करेगा
- Medication requests return करेगा

---

### Tool 11: `check_refill_status`

**Test Phrases:**

1. "Do I need any refills?"
2. "Check my refill status for Lisinopril"
3. "What medications need refilling?"
4. "Check if my medications need refills"
5. "Show me refill status for my medications"

**Expected Behavior:**
- Agent `check_refill_status` tool use करेगा
- Refill status return करेगा

---

### Tool 12: `get_medication_statements`

**Test Phrases:**

1. "Show me my medication history"
2. "What medications have I taken in the past?"
3. "Get my medication statements"
4. "List my historical medications"
5. "Show me past medication use"

**Expected Behavior:**
- Agent `get_medication_statements` tool use करेगा
- Medication history return करेगा

---

## 👨‍⚕️ Provider Tools (4 tools)

### Tool 13: `search_providers`

**Test Phrases:**

1. "Find a doctor named Dr. Johnson"
2. "Search for providers"
3. "Look up healthcare providers"
4. "Find providers with specialty Cardiology"
5. "Search for doctors"

**Expected Behavior:**
- Agent `search_providers` tool use करेगा
- Provider search results return करेगा

---

### Tool 14: `get_provider_details`

**Test Phrases:**

1. "Show me details for provider [provider-id]"
2. "Get information about provider [id]"
3. "What are the details of provider [id]?"
4. "Tell me about provider [id]"

**Note:** आपको provider ID चाहिए (tool #13 से मिल सकता है)

**Expected Behavior:**
- Agent `get_provider_details` tool use करेगा
- Provider details return करेगा

---

### Tool 15: `search_locations`

**Test Phrases:**

1. "Find healthcare locations"
2. "Search for medical facilities"
3. "Look up healthcare locations"
4. "Find locations near me"
5. "Show me available healthcare locations"

**Expected Behavior:**
- Agent `search_locations` tool use करेगा
- Location search results return करेगा

---

### Tool 16: `get_location_details`

**Test Phrases:**

1. "Show me details for location [location-id]"
2. "Get information about location [id]"
3. "What are the details of location [id]?"
4. "Tell me about location [id]"

**Note:** आपको location ID चाहिए (tool #15 से मिल सकता है)

**Expected Behavior:**
- Agent `get_location_details` tool use करेगा
- Location details return करेगा

---

## 🏥 Clinical Tools (5 tools)

### Tool 17: `get_patient_conditions`

**Test Phrases:**

1. "What are my medical conditions?"
2. "Show me my diagnoses"
3. "List my current conditions"
4. "What conditions do I have?"
5. "Get my medical conditions"

**Expected Behavior:**
- Agent `get_patient_conditions` tool use करेगा
- Patient conditions/diagnoses return करेगा

---

### Tool 18: `get_allergies`

**Test Phrases:**

1. "What allergies do I have?"
2. "Show me my allergies"
3. "List my allergies and intolerances"
4. "What am I allergic to?"
5. "Get my allergy information"

**Expected Behavior:**
- Agent `get_allergies` tool use करेगा
- Allergies list return करेगा

---

### Tool 19: `get_recent_observations`

**Test Phrases:**

1. "Show me my recent lab results"
2. "What are my recent observations?"
3. "Get my recent vitals"
4. "Show me my latest test results"
5. "What are my recent lab values?"
6. "Get observations from the last month"

**Expected Behavior:**
- Agent `get_recent_observations` tool use करेगा
- Recent observations (vitals, labs) return करेगा

---

### Tool 20: `get_patient_procedures`

**Test Phrases:**

1. "What procedures have I had?"
2. "Show me my medical procedures"
3. "List my procedures"
4. "What procedures are in my record?"
5. "Get my procedure history"
6. "Show procedures from the last year"

**Expected Behavior:**
- Agent `get_patient_procedures` tool use करेगा
- Patient procedures return करेगा

---

### Tool 21: `get_patient_coverage`

**Test Phrases:**

1. "What's my insurance coverage?"
2. "Show me my insurance information"
3. "Get my coverage details"
4. "What insurance do I have?"
5. "Show me my patient coverage"

**Expected Behavior:**
- Agent `get_patient_coverage` tool use करेगा
- Insurance coverage information return करेगा

---

## 📝 Complete Testing Checklist

### Phase 1: Patient Setup (Tools 1-3)

- [ ] **Tool 1**: `search_patient` - "I want to check my information"
- [ ] **Tool 2**: `get_patient_details` - "Show me my full patient details"
- [ ] **Tool 3**: `verify_patient_identity` - "Verify my identity"

### Phase 2: Appointments (Tools 4-8)

- [ ] **Tool 4**: `get_upcoming_appointments` - "What are my upcoming appointments?"
- [ ] **Tool 5**: `get_appointment_details` - "Tell me about appointment [id]"
- [ ] **Tool 6**: `check_appointment_status` - "What's the status of appointment [id]?"
- [ ] **Tool 7**: `find_patient_next_appointment` - "When is my next appointment?"
- [ ] **Tool 8**: `get_appointments_by_date_range` - "Show me appointments in March"

### Phase 3: Medications (Tools 9-12)

- [ ] **Tool 9**: `get_patient_medications` - "What medications am I taking?"
- [ ] **Tool 10**: `get_medication_requests` - "Show me my medication requests"
- [ ] **Tool 11**: `check_refill_status` - "Do I need any refills?"
- [ ] **Tool 12**: `get_medication_statements` - "Show me my medication history"

### Phase 4: Providers & Locations (Tools 13-16)

- [ ] **Tool 13**: `search_providers` - "Find a doctor named Dr. Johnson"
- [ ] **Tool 14**: `get_provider_details` - "Show me details for provider [id]"
- [ ] **Tool 15**: `search_locations` - "Find healthcare locations"
- [ ] **Tool 16**: `get_location_details` - "Show me details for location [id]"

### Phase 5: Clinical Data (Tools 17-21)

- [ ] **Tool 17**: `get_patient_conditions` - "What are my medical conditions?"
- [ ] **Tool 18**: `get_allergies` - "What allergies do I have?"
- [ ] **Tool 19**: `get_recent_observations` - "Show me my recent lab results"
- [ ] **Tool 20**: `get_patient_procedures` - "What procedures have I had?"
- [ ] **Tool 21**: `get_patient_coverage` - "What's my insurance coverage?"

---

## 🎤 Voice Testing Steps

### Step 1: Open RetellAI Test Interface

1. Go to: `https://dashboard.retellai.com`
2. Select your agent
3. Click **"Test Agent"** tab
4. Click **"Test Audio"** sub-tab
5. Click **"Test"** button

### Step 2: Start Testing

1. **Agent will greet you first** (if "AI speaks first" is enabled)
2. **You respond** with test phrases from above
3. **Agent will use tools** and respond with results
4. **Continue** with next tool test phrase

### Step 3: Monitor Tool Usage

- **RetellAI Dashboard** → **"Logs"** tab में tool calls देख सकते हैं
- **MCP Server Terminal** में request logs देख सकते हैं
- **Response data** verify करें

---

## 🔍 What to Check During Testing

### ✅ For Each Tool:

1. **Tool is called correctly** - Check logs
2. **Correct parameters passed** - Verify in logs
3. **Response received** - Agent should share results
4. **Natural conversation** - Agent should explain what it's doing
5. **Error handling** - If tool fails, agent should explain gracefully

### ✅ Overall Flow:

1. **Patient verification** happens first
2. **Tools are used proactively** (not asking permission)
3. **Information is presented clearly**
4. **Follow-up questions** are asked naturally
5. **HIPAA compliance** maintained throughout

---

## 🐛 Troubleshooting

### Problem: Agent not using tools

**Solution:**
- Check Global Prompt में tool usage instructions हैं
- Verify MCP tools are selected in RetellAI
- Check MCP server is running and accessible

### Problem: Tool returns error

**Solution:**
- Check MCP server logs
- Verify patient ID is correct
- Check authentication token is valid
- Verify FHIR API permissions

### Problem: Agent asking for verification repeatedly

**Solution:**
- Check if patient search was successful
- Verify patient ID is stored in conversation context
- Check if Extract Variable nodes are configured correctly

### Problem: No response from agent

**Solution:**
- Check MCP server is running
- Verify Cloudflare tunnel is active
- Check RetellAI logs for errors
- Verify network connectivity

---

## 📊 Testing Results Template

```
Date: ___________
Tester: ___________

Tool # | Tool Name | Status | Notes
-------|-----------|--------|-------
1 | search_patient | ✅/❌ | 
2 | get_patient_details | ✅/❌ | 
3 | verify_patient_identity | ✅/❌ | 
4 | get_upcoming_appointments | ✅/❌ | 
5 | get_appointment_details | ✅/❌ | 
6 | check_appointment_status | ✅/❌ | 
7 | find_patient_next_appointment | ✅/❌ | 
8 | get_appointments_by_date_range | ✅/❌ | 
9 | get_patient_medications | ✅/❌ | 
10 | get_medication_requests | ✅/❌ | 
11 | check_refill_status | ✅/❌ | 
12 | get_medication_statements | ✅/❌ | 
13 | search_providers | ✅/❌ | 
14 | get_provider_details | ✅/❌ | 
15 | search_locations | ✅/❌ | 
16 | get_location_details | ✅/❌ | 
17 | get_patient_conditions | ✅/❌ | 
18 | get_allergies | ✅/❌ | 
19 | get_recent_observations | ✅/❌ | 
20 | get_patient_procedures | ✅/❌ | 
21 | get_patient_coverage | ✅/❌ | 

Overall Status: ___________
Issues Found: ___________
```

---

## 🎉 Success Criteria

✅ All 21 tools successfully called via voice  
✅ Natural conversation flow maintained  
✅ Patient verification works correctly  
✅ Error handling works gracefully  
✅ HIPAA compliance maintained  
✅ Information presented clearly  

---

## 🚀 Quick Start Command

```bash
# Terminal 1: Start MCP Server
npm run dev

# Terminal 2: Start Cloudflare Tunnel (if needed)
cloudflared tunnel --url http://localhost:3000

# Then: Open RetellAI Dashboard → Test Agent → Test Audio
```

---

**Happy Testing! 🎤**

All 21 tools को voice agent के through test करने के लिए यह guide use करें।

