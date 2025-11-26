#!/usr/bin/env node

import express from 'express';
import { AuthService } from './services/auth.service.js';
import { FHIRService } from './services/fhir.service.js';
import { PatientTools } from './tools/patient.tools.js';
import { config } from './config/environment.js';

const app = express();
app.use(express.json());

// Initialize services
const authService = new AuthService();
const fhirService = new FHIRService(authService);
const patientTools = new PatientTools(fhirService);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    environment: config.nodeEnv,
    fhirBaseUrl: config.fhirBaseUrl,
    timestamp: new Date().toISOString()
  });
});

// List available tools
app.get('/tools', (req, res) => {
  res.json({
    tools: [
      {
        name: 'search_patient',
        description: 'Search for patients by name, ID, or other criteria',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Patient name to search for' },
            identifier: { type: 'string', description: 'Patient identifier' },
            birthDate: { type: 'string', description: 'Patient birth date (YYYY-MM-DD)' }
          }
        }
      },
      {
        name: 'get_patient_details',
        description: 'Get detailed information about a specific patient',
        inputSchema: {
          type: 'object',
          properties: {
            patientId: { type: 'string', description: 'Patient ID' }
          },
          required: ['patientId']
        }
      },
      {
        name: 'verify_patient_identity',
        description: 'Verify patient identity using multiple criteria',
        inputSchema: {
          type: 'object',
          properties: {
            patientId: { type: 'string', description: 'Patient ID' },
            name: { type: 'string', description: 'Patient name' },
            birthDate: { type: 'string', description: 'Patient birth date' },
            identifier: { type: 'string', description: 'Patient identifier' }
          }
        }
      }
    ]
  });
});

// Test patient search
app.post('/test/search-patient', async (req, res) => {
  try {
    const { name, birthDate } = req.body;
    const result = await patientTools.searchPatient({ name, birthDate });
    res.json(result);
  } catch (error: any) {
    console.error('Error in patient search:', error);
    res.status(500).json({ error: 'Failed to search patients', details: error.message });
  }
});

// Test patient details
app.post('/test/patient-details', async (req, res) => {
  try {
    const { patientId } = req.body;
    const result = await patientTools.getPatientDetails({ patientId });
    res.json(result);
  } catch (error: any) {
    console.error('Error getting patient details:', error);
    res.status(500).json({ error: 'Failed to get patient details', details: error.message });
  }
});

// Test authentication
app.get('/test/auth', async (req, res) => {
  try {
    const token = await authService.getAccessToken();
    res.json({
      success: true,
      hasToken: !!token,
      tokenLength: token ? token.length : 0,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Error testing authentication:', error);
    res.status(500).json({ 
      error: 'Authentication failed', 
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

const PORT = parseInt(process.env.MCP_SERVER_PORT || '3000');
const HOST = process.env.MCP_SERVER_HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`🚀 Veradigm FHIR MCP Test Server running on ${HOST}:${PORT}`);
  console.log(`📊 Environment: ${config.nodeEnv}`);
  console.log(`🔗 FHIR Base URL: ${config.fhirBaseUrl}`);
  console.log(`🔑 Authentication: ${authService ? 'Configured' : 'Not configured'}`);
  console.log(`\n📋 Available endpoints:`);
  console.log(`   GET  /health - Health check`);
  console.log(`   GET  /tools - List available tools`);
  console.log(`   GET  /test/auth - Test authentication`);
  console.log(`   POST /test/search-patient - Test patient search`);
  console.log(`   POST /test/patient-details - Test patient details`);
  console.log(`\n🧪 Test the server with:`);
  console.log(`   curl http://localhost:${PORT}/health`);
  console.log(`   curl http://localhost:${PORT}/test/auth`);
});
