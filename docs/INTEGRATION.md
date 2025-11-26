# RetellAI Integration Guide

## Overview

This guide provides step-by-step instructions for integrating the Veradigm FHIR MCP Server with RetellAI voice agents.

## Prerequisites

- RetellAI account and API access
- Veradigm FHIR API credentials
- MCP Server deployed and accessible
- Node.js 18+ for local development

## Integration Steps

### 1. Deploy MCP Server

#### Option A: Docker Deployment (Recommended)

```bash
# Clone repository
git clone <repository-url>
cd veradigm-fhir-mcp-server

# Configure environment
cp .env.example .env
# Edit .env with your credentials

# Deploy with Docker Compose
docker-compose up -d

# Verify deployment
docker-compose logs -f
```

#### Option B: Local Deployment

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your credentials

# Build and start
npm run build
npm start
```

### 2. Configure RetellAI

#### MCP Server Configuration

In your RetellAI dashboard, configure the MCP server:

```json
{
  "mcpServers": {
    "veradigm-fhir": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "NODE_ENV": "sandbox",
        "CLIENT_ID": "your_client_id",
        "CLIENT_SECRET": "your_client_secret",
        "FHIR_BASE_URL_SANDBOX": "https://scmlatestdev.open.allscripts.com/FHIR",
        "TOKEN_URL_SANDBOX": "https://scmlatestdev.open.allscripts.com/oauth2/token"
      }
    }
  }
}
```

#### Docker Configuration

```json
{
  "mcpServers": {
    "veradigm-fhir": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "veradigm-fhir-mcp-server"],
      "env": {
        "NODE_ENV": "sandbox",
        "CLIENT_ID": "your_client_id",
        "CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

### 3. Voice Agent Implementation

#### Basic Integration Example

```javascript
// RetellAI voice agent integration
class FHIRVoiceAgent {
  constructor(mcpClient) {
    this.mcpClient = mcpClient;
  }

  async handleIncomingCall(callData) {
    try {
      // Verify caller identity
      const identityResult = await this.mcpClient.callTool({
        name: 'verify_patient_identity',
        arguments: {
          firstName: callData.callerFirstName,
          lastName: callData.callerLastName,
          phone: callData.callerPhone
        }
      });

      if (identityResult.verified) {
        return this.handleVerifiedPatient(identityResult.patient);
      } else {
        return this.handleUnknownCaller();
      }
    } catch (error) {
      console.error('FHIR integration error:', error);
      return this.handleError();
    }
  }

  async handleVerifiedPatient(patient) {
    // Get upcoming appointments
    const appointments = await this.mcpClient.callTool({
      name: 'get_upcoming_appointments',
      arguments: {
        patientId: patient.id,
        limit: 5
      }
    });

    // Get next appointment
    const nextAppointment = await this.mcpClient.callTool({
      name: 'find_patient_next_appointment',
      arguments: {
        patientId: patient.id
      }
    });

    return {
      patient: patient,
      appointments: appointments.appointments,
      nextAppointment: nextAppointment.appointment
    };
  }
}
```

#### Call Answering Flow

```javascript
async function handleCallAnswering(callData) {
  const agent = new FHIRVoiceAgent(mcpClient);
  
  // Step 1: Verify caller identity
  const identity = await agent.verifyCallerIdentity(callData);
  
  if (identity.verified) {
    // Step 2: Get patient context
    const context = await agent.getPatientContext(identity.patient.id);
    
    // Step 3: Determine call purpose
    const purpose = await agent.determineCallPurpose(context);
    
    // Step 4: Route or assist
    return await agent.handleCallPurpose(purpose, context);
  } else {
    // Step 5: Handle unknown caller
    return await agent.handleUnknownCaller(identity.suggestions);
  }
}
```

#### Appointment Confirmation Flow

```javascript
async function handleAppointmentConfirmation(patientId) {
  try {
    // Get next appointment
    const nextAppointment = await mcpClient.callTool({
      name: 'find_patient_next_appointment',
      arguments: { patientId }
    });

    if (nextAppointment.found) {
      const appointment = nextAppointment.appointment;
      
      // Get appointment details
      const details = await mcpClient.callTool({
        name: 'get_appointment_details',
        arguments: { appointmentId: appointment.id }
      });

      return {
        confirmed: true,
        appointment: details,
        message: `Your appointment with ${details.practitionerName} is scheduled for ${formatDateTime(details.start)} at ${details.locationName}`
      };
    } else {
      return {
        confirmed: false,
        message: "No upcoming appointments found"
      };
    }
  } catch (error) {
    return {
      confirmed: false,
      error: error.message
    };
  }
}
```

#### Medication Inquiry Flow

```javascript
async function handleMedicationInquiry(patientId, medicationName) {
  try {
    // Get patient medications
    const medications = await mcpClient.callTool({
      name: 'get_patient_medications',
      arguments: { patientId }
    });

    // Check refill status
    const refillStatus = await mcpClient.callTool({
      name: 'check_refill_status',
      arguments: { patientId, medicationName }
    });

    return {
      medications: medications.medications,
      refillStatus: refillStatus.medications,
      canRefill: refillStatus.medications.some(m => m.canRefill)
    };
  } catch (error) {
    return {
      error: error.message,
      medications: []
    };
  }
}
```

### 4. Error Handling

#### Retry Logic

```javascript
async function callFHIRWithRetry(toolName, args, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await mcpClient.callTool({
        name: toolName,
        arguments: args
      });
    } catch (error) {
      if (error.code === 'RATE_LIMIT' && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}
```

#### Error Response Handling

```javascript
function handleFHIRError(error) {
  switch (error.code) {
    case 'AUTH_ERROR':
      return "I'm having trouble accessing your medical records. Please try again later.";
    
    case 'NOT_FOUND':
      return "I couldn't find that information in your medical records.";
    
    case 'RATE_LIMIT':
      return "The system is busy right now. Please try again in a moment.";
    
    case 'VALIDATION_ERROR':
      return "I need more information to help you. Could you please provide your full name and date of birth?";
    
    default:
      return "I'm experiencing technical difficulties. Please try again later or contact your healthcare provider.";
  }
}
```

### 5. Voice Agent Scenarios

#### Scenario 1: Call Answering

```javascript
async function handleIncomingCall(callData) {
  const responses = [];
  
  // Greet caller
  responses.push("Hello, this is your healthcare assistant. How can I help you today?");
  
  // Collect caller information
  const callerInfo = await collectCallerInformation();
  
  // Verify identity
  const identity = await verifyPatientIdentity(callerInfo);
  
  if (identity.verified) {
    responses.push(`Hello ${identity.patient.firstName}, I can help you with your healthcare needs.`);
    
    // Get patient context
    const context = await getPatientContext(identity.patient.id);
    responses.push(await generateContextualResponse(context));
  } else {
    responses.push("I need to verify your identity. Could you please provide your full name and date of birth?");
  }
  
  return responses;
}
```

#### Scenario 2: Appointment Confirmation

```javascript
async function confirmAppointment(patientId) {
  const responses = [];
  
  // Get next appointment
  const nextAppointment = await findPatientNextAppointment(patientId);
  
  if (nextAppointment.found) {
    const appointment = nextAppointment.appointment;
    const formattedDate = formatDateTime(appointment.start);
    
    responses.push(`I found your next appointment with ${appointment.practitionerName} on ${formattedDate} at ${appointment.locationName}.`);
    responses.push("Is this appointment still convenient for you?");
    
    // Handle confirmation response
    const confirmation = await collectConfirmationResponse();
    
    if (confirmation === 'yes') {
      responses.push("Great! I'll confirm your appointment. Is there anything else I can help you with?");
    } else {
      responses.push("I understand. Would you like me to help you reschedule this appointment?");
    }
  } else {
    responses.push("I don't see any upcoming appointments in your schedule. Would you like to schedule a new appointment?");
  }
  
  return responses;
}
```

#### Scenario 3: Medication Inquiry

```javascript
async function handleMedicationInquiry(patientId, inquiry) {
  const responses = [];
  
  // Get patient medications
  const medications = await getPatientMedications(patientId);
  
  if (medications.medications.length > 0) {
    responses.push(`I can see you have ${medications.medications.length} active medications.`);
    
    // Check for specific medication
    if (inquiry.medicationName) {
      const refillStatus = await checkRefillStatus(patientId, inquiry.medicationName);
      const medication = refillStatus.medications.find(m => m.medicationName.includes(inquiry.medicationName));
      
      if (medication) {
        responses.push(`${medication.medicationName} is ${medication.status}. ${medication.refillInfo}`);
      } else {
        responses.push("I don't see that medication in your current prescriptions.");
      }
    } else {
      // List all medications
      responses.push("Your current medications are:");
      medications.medications.forEach(med => {
        responses.push(`- ${med.medicationName} (${med.status})`);
      });
    }
  } else {
    responses.push("I don't see any active medications in your current prescriptions.");
  }
  
  return responses;
}
```

### 6. Testing Integration

#### Unit Testing

```javascript
// Test patient verification
describe('Patient Verification', () => {
  test('should verify patient identity', async () => {
    const result = await mcpClient.callTool({
      name: 'verify_patient_identity',
      arguments: {
        firstName: 'John',
        lastName: 'Doe',
        birthDate: '1990-01-01'
      }
    });
    
    expect(result.verified).toBe(true);
    expect(result.patient).toBeDefined();
  });
});
```

#### Integration Testing

```javascript
// Test complete call flow
describe('Call Flow Integration', () => {
  test('should handle complete call answering flow', async () => {
    const callData = {
      callerFirstName: 'John',
      callerLastName: 'Doe',
      callerPhone: '555-123-4567'
    };
    
    const result = await handleIncomingCall(callData);
    
    expect(result.patient).toBeDefined();
    expect(result.appointments).toBeDefined();
  });
});
```

### 7. Monitoring and Logging

#### Health Checks

```javascript
// Monitor MCP server health
async function checkMCPHealth() {
  try {
    const result = await mcpClient.callTool({
      name: 'get_patient_details',
      arguments: { patientId: 'test-patient-id' }
    });
    return { status: 'healthy', timestamp: new Date().toISOString() };
  } catch (error) {
    return { status: 'unhealthy', error: error.message, timestamp: new Date().toISOString() };
  }
}
```

#### Performance Monitoring

```javascript
// Monitor tool call performance
async function monitorToolPerformance(toolName, args) {
  const startTime = Date.now();
  
  try {
    const result = await mcpClient.callTool({ name: toolName, arguments: args });
    const duration = Date.now() - startTime;
    
    console.log(`Tool ${toolName} completed in ${duration}ms`);
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`Tool ${toolName} failed after ${duration}ms:`, error);
    throw error;
  }
}
```

## Best Practices

### 1. Error Handling
- Always implement retry logic for transient errors
- Provide user-friendly error messages
- Log errors for debugging and monitoring

### 2. Performance
- Cache frequently accessed data
- Use pagination for large result sets
- Implement request timeouts

### 3. Security
- Never log sensitive patient data
- Use secure token storage
- Implement proper access controls

### 4. User Experience
- Provide clear, conversational responses
- Handle edge cases gracefully
- Offer alternative actions when primary actions fail

## Troubleshooting

### Common Issues

1. **Authentication Errors**
   - Verify CLIENT_ID and CLIENT_SECRET
   - Check token expiration
   - Ensure proper scopes are granted

2. **Network Errors**
   - Verify FHIR base URL is correct
   - Check network connectivity
   - Implement retry logic

3. **Data Not Found**
   - Verify patient IDs are correct
   - Check date ranges for appointments
   - Handle empty result sets gracefully

### Debug Mode

Enable debug logging by setting `LOG_LEVEL=debug` in your environment configuration.

## Support

For technical support:
- Check the [API Documentation](API.md)
- Review [Use Cases](USE_CASES.md)
- Contact Veradigm support for FHIR API issues
- Contact RetellAI support for voice agent issues




