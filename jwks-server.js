const express = require('express');
const app = express();

// Simple JWKS endpoint for Veradigm registration
app.get('/.well-known/jwks.json', (req, res) => {
  const jwks = {
    keys: [
      {
        kty: 'RSA',
        use: 'sig',
        kid: 'mcp-server-key-1',
        alg: 'RS256',
        n: 'placeholder-public-key-modulus-for-veradigm-registration',
        e: 'AQAB'
      }
    ]
  };
  
  res.json(jwks);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'veradigm-fhir-mcp-jwks',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`JWKS endpoint running on port ${PORT}`);
  console.log(`JWKS URI: http://localhost:${PORT}/.well-known/jwks.json`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});




