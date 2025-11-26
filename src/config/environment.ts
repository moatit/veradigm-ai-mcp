import dotenv from 'dotenv';

dotenv.config();

export interface EnvironmentConfig {
  nodeEnv: 'sandbox' | 'production';
  clientId: string;
  clientSecret: string;
  fhirBaseUrl: string;
  authUrl: string;
  tokenUrl: string;
  mcpServerPort: number;
  mcpServerHost: string;
  tokenCacheTtl: number;
  cacheEnabled: boolean;
  logLevel: string;
}

function getEnvironmentConfig(): EnvironmentConfig {
  const nodeEnv = (process.env.NODE_ENV as 'sandbox' | 'production') || 'sandbox';
  const isSandbox = nodeEnv === 'sandbox';

  if (!process.env.CLIENT_ID || !process.env.CLIENT_SECRET) {
    throw new Error('CLIENT_ID and CLIENT_SECRET environment variables are required');
  }

  return {
    nodeEnv,
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    fhirBaseUrl: isSandbox 
      ? process.env.FHIR_BASE_URL_SANDBOX || 'https://scmlatestdev.open.allscripts.com/FHIR'
      : process.env.FHIR_BASE_URL_PRODUCTION || '',
    authUrl: isSandbox
      ? process.env.AUTH_URL_SANDBOX || 'https://scmlatestdev.open.allscripts.com/oauth2/authorize'
      : process.env.AUTH_URL_PRODUCTION || '',
    tokenUrl: isSandbox
      ? process.env.TOKEN_URL_SANDBOX || 'https://scmlatestdev.open.allscripts.com/oauth2/token'
      : process.env.TOKEN_URL_PRODUCTION || '',
    mcpServerPort: parseInt(process.env.MCP_SERVER_PORT || '3000'),
    mcpServerHost: process.env.MCP_SERVER_HOST || 'localhost',
    tokenCacheTtl: parseInt(process.env.TOKEN_CACHE_TTL || '3600'),
    cacheEnabled: process.env.CACHE_ENABLED === 'true',
    logLevel: process.env.LOG_LEVEL || 'info'
  };
}

export const config = getEnvironmentConfig();

