# Voice Agent Use Cases

## Overview

This document outlines common voice agent scenarios and conversation flows for the Veradigm FHIR MCP Server integration. These use cases demonstrate how AI voice agents can leverage FHIR data to provide intelligent healthcare assistance.

## Use Case 1: Call Answering and Patient Verification

### Scenario
A patient calls the healthcare provider's main number. The AI voice agent needs to identify the caller and route them appropriately.

### Conversation Flow

```
Agent: "Hello, this is your healthcare assistant. How can I help you today?"

Caller: "Hi, I'm calling about my appointment."

Agent: "I'd be happy to help you with your appointment. To access your information, I'll need to verify your identity. Could you please provide your full name and date of birth?"

Caller: "My name is John Doe and my birthday is January 1st, 1990."

Agent: "Thank you, John. Let me verify that information... [Pause for verification] Great! I found your account. I can see you have an upcoming appointment with Dr. Smith on February 15th at 10:00 AM. Is this what you're calling about?"

Caller: "Yes, that's the one."

Agent: "Perfect! How can I help you with that appointment?"
```

### Technical Implementation

```javascript
async function handleCallAnswering(callData) {
  // Step 1: Collect caller information
  const callerInfo = {
    firstName: callData.callerFirstName,
    lastName: callData.callerLastName,
    phone: callData.callerPhone
  };

  // Step 2: Verify patient identity
  const identityResult = await mcpClient.callTool({
    name: 'verify_patient_identity',
    arguments: {
      firstName: callerInfo.firstName,
      lastName: callerInfo.lastName,
      phone: callerInfo.phone
    }
  });

  if (identityResult.verified) {
    // Step 3: Get patient context
    const context = await getPatientContext(identityResult.patient.id);
    
    // Step 4: Generate personalized greeting
    return generatePersonalizedGreeting(identityResult.patient, context);
  } else {
    // Step 5: Handle unknown caller
    return handleUnknownCaller(identityResult.suggestions);
  }
}
```

## Use Case 2: Appointment Confirmation

### Scenario
The AI voice agent calls patients to confirm their upcoming appointments.

### Conversation Flow

```
Agent: "Hello, this is your healthcare assistant calling to confirm your upcoming appointment."

Patient: "Oh, yes, I was expecting this call."

Agent: "Great! I can see you have an appointment with Dr. Smith on February 15th at 10:00 AM at our Main Clinic location. Will you be able to make it to this appointment?"

Patient: "Yes, that works for me."

Agent: "Excellent! I've confirmed your appointment. Please arrive 15 minutes early for check-in. Is there anything else I can help you with today?"

Patient: "No, that's all. Thank you!"

Agent: "You're welcome! Have a great day, and we'll see you on February 15th."
```

### Technical Implementation

```javascript
async function confirmAppointment(patientId) {
  // Step 1: Get next appointment
  const nextAppointment = await mcpClient.callTool({
    name: 'find_patient_next_appointment',
    arguments: { patientId }
  });

  if (nextAppointment.found) {
    const appointment = nextAppointment.appointment;
    
    // Step 2: Get appointment details
    const details = await mcpClient.callTool({
      name: 'get_appointment_details',
      arguments: { appointmentId: appointment.id }
    });

    // Step 3: Generate confirmation message
    const message = `I can see you have an appointment with ${details.practitionerName} on ${formatDateTime(details.start)} at ${details.locationName}. Will you be able to make it to this appointment?`;
    
    return {
      confirmed: true,
      appointment: details,
      message: message
    };
  } else {
    return {
      confirmed: false,
      message: "No upcoming appointments found"
    };
  }
}
```

## Use Case 3: Medication Inquiry

### Scenario
A patient calls to ask about their medications and refill status.

### Conversation Flow

```
Agent: "Hello, this is your healthcare assistant. How can I help you today?"

Patient: "Hi, I'm calling about my medications."

Agent: "I'd be happy to help you with your medications. Let me verify your identity first. Could you please provide your full name and date of birth?"

Patient: "My name is John Doe and my birthday is January 1st, 1990."

Agent: "Thank you, John. I can see you have several active medications. Let me check your current prescriptions... You have Lisinopril 10mg, which is active and eligible for refill, and Metformin 500mg, which is also active and eligible for refill. Is there a specific medication you'd like to know more about?"

Patient: "Yes, I'm running low on my Lisinopril. Can I get a refill?"

Agent: "I can see that your Lisinopril prescription is eligible for refill. However, I can only provide information about your medications. To request a refill, you'll need to contact your pharmacy or speak with your healthcare provider. Would you like me to help you find your pharmacy's contact information?"

Patient: "Yes, that would be helpful."

Agent: "I can see your pharmacy information in your records. Would you like me to provide that information?"
```

### Technical Implementation

```javascript
async function handleMedicationInquiry(patientId, inquiry) {
  // Step 1: Get patient medications
  const medications = await mcpClient.callTool({
    name: 'get_patient_medications',
    arguments: { patientId }
  });

  // Step 2: Check refill status
  const refillStatus = await mcpClient.callTool({
    name: 'check_refill_status',
    arguments: { patientId }
  });

  // Step 3: Generate medication summary
  const summary = generateMedicationSummary(medications.medications, refillStatus.medications);
  
  return {
    medications: medications.medications,
    refillStatus: refillStatus.medications,
    summary: summary
  };
}
```

## Use Case 4: Provider Lookup

### Scenario
A patient calls to find information about their healthcare provider.

### Conversation Flow

```
Agent: "Hello, this is your healthcare assistant. How can I help you today?"

Patient: "Hi, I need to contact my doctor."

Agent: "I'd be happy to help you find your doctor's contact information. Let me verify your identity first. Could you please provide your full name and date of birth?"

Patient: "My name is John Doe and my birthday is January 1st, 1990."

Agent: "Thank you, John. I can see that your primary care provider is Dr. Jane Smith. She's an Internal Medicine specialist. Her contact information is 555-987-6543, and her email is jane.smith@clinic.com. She's located at our Main Clinic at 123 Medical Center Drive. Is there anything specific you need to discuss with Dr. Smith?"

Patient: "I need to schedule an appointment."

Agent: "I can help you with that. I can see you have an upcoming appointment with Dr. Smith on February 15th at 10:00 AM. Would you like to schedule an additional appointment, or do you need to modify your existing one?"

Patient: "I need to schedule an additional appointment."

Agent: "I understand you need to schedule an additional appointment. For scheduling, I'll need to transfer you to our appointment scheduling team. Let me connect you with them now."
```

### Technical Implementation

```javascript
async function handleProviderLookup(patientId) {
  // Step 1: Get patient's appointments to find providers
  const appointments = await mcpClient.callTool({
    name: 'get_upcoming_appointments',
    arguments: { patientId, limit: 5 }
  });

  // Step 2: Get provider details
  const providers = [];
  for (const appointment of appointments.appointments) {
    if (appointment.practitionerId) {
      const provider = await mcpClient.callTool({
        name: 'get_provider_details',
        arguments: { providerId: appointment.practitionerId }
      });
      providers.push(provider);
    }
  }

  return {
    providers: providers,
    appointments: appointments.appointments
  };
}
```

## Use Case 5: Clinical Context for Better Assistance

### Scenario
A patient calls with a medical question, and the AI needs to provide context-aware assistance.

### Conversation Flow

```
Agent: "Hello, this is your healthcare assistant. How can I help you today?"

Patient: "Hi, I'm having some chest pain and I'm not sure if I should be concerned."

Agent: "I understand you're experiencing chest pain, and I want to make sure you get the appropriate care. Let me verify your identity first. Could you please provide your full name and date of birth?"

Patient: "My name is John Doe and my birthday is January 1st, 1990."

Agent: "Thank you, John. I can see from your medical records that you have a history of hypertension and you're currently taking Lisinopril. Given your symptoms and medical history, I strongly recommend that you seek immediate medical attention. Chest pain can be a serious symptom, especially with your existing conditions. Would you like me to help you find the nearest emergency room, or would you prefer to contact your primary care provider, Dr. Smith?"

Patient: "I think I should go to the emergency room."

Agent: "That's a wise decision, John. I can see that the nearest emergency room to your location is City General Hospital at 456 Emergency Drive. Their phone number is 555-911-HELP. I recommend calling 911 for immediate assistance, or if you can safely transport yourself, you can call the hospital directly. Is there anything else I can help you with before you seek medical attention?"

Patient: "No, thank you for the information."

Agent: "You're welcome, John. Please take care of yourself, and I hope you feel better soon. If you need any follow-up assistance after your visit, please don't hesitate to call back."
```

### Technical Implementation

```javascript
async function handleClinicalContext(patientId, symptoms) {
  // Step 1: Get patient conditions
  const conditions = await mcpClient.callTool({
    name: 'get_patient_conditions',
    arguments: { patientId }
  });

  // Step 2: Get patient medications
  const medications = await mcpClient.callTool({
    name: 'get_patient_medications',
    arguments: { patientId }
  });

  // Step 3: Get recent observations
  const observations = await mcpClient.callTool({
    name: 'get_recent_observations',
    arguments: { patientId, category: 'vital-signs', limit: 5 }
  });

  // Step 4: Analyze clinical context
  const clinicalContext = analyzeClinicalContext(conditions, medications, observations, symptoms);
  
  return {
    conditions: conditions.conditions,
    medications: medications.medications,
    observations: observations.observations,
    clinicalContext: clinicalContext
  };
}
```

## Use Case 6: Appointment Rescheduling

### Scenario
A patient calls to reschedule their appointment.

### Conversation Flow

```
Agent: "Hello, this is your healthcare assistant. How can I help you today?"

Patient: "Hi, I need to reschedule my appointment."

Agent: "I'd be happy to help you reschedule your appointment. Let me verify your identity first. Could you please provide your full name and date of birth?"

Patient: "My name is John Doe and my birthday is January 1st, 1990."

Agent: "Thank you, John. I can see you have an appointment with Dr. Smith on February 15th at 10:00 AM. Is this the appointment you'd like to reschedule?"

Patient: "Yes, that's the one."

Agent: "I understand you need to reschedule that appointment. Unfortunately, I can only provide information about your appointments. To reschedule, you'll need to speak with our appointment scheduling team. Let me transfer you to them now. They'll be able to help you find a new time that works for you."

Patient: "That sounds good. Thank you."

Agent: "You're welcome, John. I'm connecting you with our scheduling team now. Have a great day!"
```

### Technical Implementation

```javascript
async function handleAppointmentRescheduling(patientId) {
  // Step 1: Get upcoming appointments
  const appointments = await mcpClient.callTool({
    name: 'get_upcoming_appointments',
    arguments: { patientId }
  });

  // Step 2: Get next appointment
  const nextAppointment = await mcpClient.callTool({
    name: 'find_patient_next_appointment',
    arguments: { patientId }
  });

  if (nextAppointment.found) {
    // Step 3: Provide appointment details and transfer to scheduling
    return {
      appointment: nextAppointment.appointment,
      canReschedule: true,
      message: "I can see your appointment details. Let me transfer you to our scheduling team for rescheduling."
    };
  } else {
    return {
      canReschedule: false,
      message: "I don't see any upcoming appointments to reschedule."
    };
  }
}
```

## Use Case 7: Insurance Verification

### Scenario
A patient calls to verify their insurance coverage.

### Conversation Flow

```
Agent: "Hello, this is your healthcare assistant. How can I help you today?"

Patient: "Hi, I need to check my insurance coverage."

Agent: "I'd be happy to help you with your insurance information. Let me verify your identity first. Could you please provide your full name and date of birth?"

Patient: "My name is John Doe and my birthday is January 1st, 1990."

Agent: "Thank you, John. I can see your insurance information in your records. You have active coverage with Blue Cross Blue Shield, and your subscriber ID is SUB123456. Your coverage is active through December 31st, 2024. Is there anything specific about your coverage you'd like to know more about?"

Patient: "I want to make sure my upcoming appointment will be covered."

Agent: "I can see that your coverage is active and should cover your upcoming appointment with Dr. Smith on February 15th. However, for specific coverage details and any potential copays, I recommend contacting your insurance provider directly. Would you like me to provide you with their contact information?"

Patient: "Yes, that would be helpful."

Agent: "I can see that your insurance provider is Blue Cross Blue Shield. Their customer service number is 1-800-555-1234. They'll be able to provide you with specific coverage details for your appointment."
```

### Technical Implementation

```javascript
async function handleInsuranceVerification(patientId) {
  // Step 1: Get patient coverage
  const coverage = await mcpClient.callTool({
    name: 'get_patient_coverage',
    arguments: { patientId }
  });

  // Step 2: Get upcoming appointments
  const appointments = await mcpClient.callTool({
    name: 'get_upcoming_appointments',
    arguments: { patientId }
  });

  return {
    coverage: coverage.coverage,
    appointments: appointments.appointments,
    coverageStatus: analyzeCoverageStatus(coverage.coverage, appointments.appointments)
  };
}
```

## Best Practices for Voice Agent Implementation

### 1. Identity Verification
- Always verify patient identity before accessing medical information
- Use multiple verification methods (name, DOB, phone, MRN)
- Implement fallback verification for edge cases

### 2. Privacy and Security
- Never log sensitive patient data
- Implement secure data transmission
- Follow HIPAA compliance guidelines

### 3. Error Handling
- Provide clear, user-friendly error messages
- Implement graceful fallbacks for system errors
- Log errors for debugging without exposing sensitive data

### 4. Conversation Flow
- Keep conversations natural and conversational
- Provide clear next steps for users
- Implement proper call transfers when needed

### 5. Clinical Context
- Use patient medical history to provide better assistance
- Implement clinical decision support where appropriate
- Always recommend professional medical care for serious symptoms

### 6. Performance
- Cache frequently accessed data
- Implement request timeouts
- Use parallel requests when possible

### 7. Monitoring
- Track conversation success rates
- Monitor system performance
- Implement health checks for all integrations

## Troubleshooting Common Scenarios

### Patient Not Found
```
Agent: "I'm having trouble finding your account with the information provided. Could you please double-check your name and date of birth? If you're still having issues, I can transfer you to our patient services team."
```

### System Errors
```
Agent: "I'm experiencing some technical difficulties accessing your information. Let me try that again... [Retry] I'm still having issues. Let me transfer you to our patient services team who can help you directly."
```

### No Upcoming Appointments
```
Agent: "I don't see any upcoming appointments in your schedule. Would you like me to help you schedule a new appointment, or is there something else I can help you with?"
```

### Medication Not Found
```
Agent: "I don't see that medication in your current prescriptions. This could mean it's not currently active, or it might be listed under a different name. Would you like me to check your complete medication history, or would you prefer to speak with your healthcare provider directly?"
```

These use cases demonstrate the power of integrating FHIR data with AI voice agents to provide intelligent, context-aware healthcare assistance while maintaining patient privacy and security.




