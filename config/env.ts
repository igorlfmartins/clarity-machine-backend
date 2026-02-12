import 'dotenv/config';

interface EnvVars {
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';
  GEMINI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  FRONTEND_URL?: string;
}

function validateEnv(): EnvVars {
  const requiredEnvVars = [
    'GEMINI_API_KEY',
    'SUPABASE_URL', 
    'SUPABASE_ANON_KEY'
  ];

  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }

  // Validate URLs
  try {
    new URL(process.env.SUPABASE_URL!);
  } catch {
    throw new Error('Invalid SUPABASE_URL format');
  }

  // Validate Gemini API key exists (format validation removed for security)

  return {
    PORT: parseInt(process.env.PORT || '3000', 10),
    NODE_ENV: (process.env.NODE_ENV || 'development') as 'development' | 'production' | 'test',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY!,
    SUPABASE_URL: process.env.SUPABASE_URL!,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY!,
    FRONTEND_URL: process.env.FRONTEND_URL
  };
}

export const env = validateEnv();

// Security helper to check if we're in production
export const isProduction = (): boolean => env.NODE_ENV === 'production';

// CORS helper to get allowed origins
export const getAllowedOrigins = (): string[] => {
  const productionOrigins = [
    env.FRONTEND_URL,
    'https://clarity-machine.up.railway.app',
    'https://clarity-machine-frontend.up.railway.app',
    'https://claritymachine.weareup.studio',
    'https://www.claritymachine.weareup.studio'
  ].filter((url): url is string => !!url).map(url => url.replace(/\/$/, ''));

  const devOrigins = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:3000',
  ];

  return isProduction() ? productionOrigins : [...productionOrigins, ...devOrigins];
};