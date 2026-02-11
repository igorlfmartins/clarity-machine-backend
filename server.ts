// Backend for Consultoria de Negocios - Railway v1.0.8
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import { createServer } from 'http';
import { setupLiveProxy } from './live_proxy.js';
import { UNIFIED_AGENT_PROMPT, TONE_INSTRUCTIONS } from './agents.js';
import { LANGUAGE_MAP, PROMPT_MAP, MODEL_NAME } from './config.js';
import { requireAuth } from './middleware/auth.js';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';

const app = express();

// Security Middleware
app.use(helmet());

const productionOrigins = [
  process.env.FRONTEND_URL,
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

const allowedOrigins = process.env.NODE_ENV === 'production'
  ? productionOrigins
  : [...productionOrigins, ...devOrigins];

app.use(cors({
  origin: (origin, callback) => {
    // Permite requisições sem origin (como apps mobile ou curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`Blocked by CORS: ${origin}`);
      callback(new Error(`Not allowed by CORS: ${origin}`));
    }
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  credentials: true
}));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Muitas requisições deste IP, por favor tente novamente mais tarde.'
});
app.use(limiter);

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Helper: Get Scoped Supabase Client
const getScopedSupabase = (authHeader: string) => {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: authHeader } }
  });
};

// Validation Schema
const consultoriaSchema = z.object({
  message: z.string().min(1, "Message is required"),
  conversationId: z.string().nullable().optional(),
  history: z.preprocess(
    (value) => {
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return [];
        }
      }
      return value;
    },
    z.array(
      z.object({
        role: z.enum(['user', 'model']),
        parts: z.array(z.object({ text: z.string() }))
      })
    ).optional()
  ),
  focus: z.string().nullable().optional(),
  language: z.string().optional(),
  toneLevel: z.preprocess(
    (value) => {
      if (typeof value === 'string') {
        return parseInt(value, 10);
      }
      return value;
    },
    z.number().int().min(1).max(3).optional()
  )
});

const storage = multer.memoryStorage();
const allowedMimeTypes = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // Increased to 10MB
  fileFilter: (_req, file, cb) => {
    if (allowedMimeTypes.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error('Invalid file type'));
  }
});

const geminiKey = process.env.GEMINI_API_KEY;
const genAI = geminiKey ? new GoogleGenerativeAI(geminiKey) : null;

// Routes
app.get('/', (req: Request, res: Response) => {
  res.status(200).send('Backend is running! v1.1.0 (Supabase Persistence)');
});

// --- Chat Management Routes ---

// GET /api/chats - List sessions
app.get('/api/chats', requireAuth, async (req: Request, res: Response) => {
  try {
    const supabase = getScopedSupabase(req.headers.authorization!);
    const { data, error } = await supabase
      .from('chats')
      .select('id, title, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    console.error('Error fetching chats:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chats/:id/messages - Get messages
app.get('/api/chats/:id/messages', requireAuth, async (req: Request, res: Response) => {
  try {
    const supabase = getScopedSupabase(req.headers.authorization!);
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('chat_id', req.params.id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/chats/:id - Delete session
app.delete('/api/chats/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const supabase = getScopedSupabase(req.headers.authorization!);
    const { error } = await supabase
      .from('chats')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting chat:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Main Consultoria Route ---

app.post('/api/consultoria', requireAuth, upload.array('files'), async (req: Request, res: Response) => {
  try {
    console.log('Consultoria Request Body:', JSON.stringify(req.body, null, 2));
    const files = req.files as Express.Multer.File[];
    console.log('Consultoria Request Files:', files?.map(f => `${f.originalname} (${f.size} bytes)`).join(', ') || 'No files');

    const validated = consultoriaSchema.parse(req.body);
    let { message, history, focus, language, toneLevel } = validated;
    let { conversationId } = validated;

    if (files && files.length > 0) {
      let attachmentsContent = '\n\n--- ARQUIVOS ANEXADOS ---\n';
      
      for (const file of files) {
        let content = '';
        try {
          if (file.mimetype === 'application/pdf') {
            const data = await pdf(file.buffer);
            content = data.text;
          } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const result = await mammoth.extractRawText({ buffer: file.buffer });
            content = result.value;
          } else {
            // Text based files
            content = file.buffer.toString('utf-8');
          }
          
          attachmentsContent += `\n[Arquivo: ${file.originalname}]\n${content}\n-------------------\n`;
        } catch (error) {
          console.error(`Error processing file ${file.originalname}:`, error);
          attachmentsContent += `\n[Arquivo: ${file.originalname}] (Erro ao processar conteúdo)\n`;
        }
      }
      
      attachmentsContent += '\n--- FIM DOS ARQUIVOS ---';
      message += attachmentsContent;
    }

    // Setup Gemini
    const targetLanguage = LANGUAGE_MAP[language || 'en'] || 'English';
    const selectedPrompt = focus ? PROMPT_MAP[focus.toLowerCase()] || UNIFIED_AGENT_PROMPT : UNIFIED_AGENT_PROMPT;
    const toneInstruction = toneLevel === 1 ? TONE_INSTRUCTIONS.level1 :
                            toneLevel === 2 ? TONE_INSTRUCTIONS.level2 :
                            TONE_INSTRUCTIONS.level3;
    const finalSystemInstruction = `${selectedPrompt}\n\n${toneInstruction}\n\nIMPORTANT: You must answer strictly in ${targetLanguage}.`;

    if (!genAI) {
      return res.status(503).json({ 
        error: 'GEMINI_API_KEY not set',
        reply: 'Erro interno no servidor.'
      });
    }

    // Initialize Supabase and User
    const supabase = getScopedSupabase(req.headers.authorization!);
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) throw new Error('Failed to get authenticated user');

    // Create/Get Session
    if (!conversationId) {
      const title = message.slice(0, 50) + (message.length > 50 ? '...' : '');
      const { data: chat, error: chatError } = await supabase
        .from('chats')
        .insert({
          user_id: user.id,
          title: title
        })
        .select()
        .single();
      
      if (chatError) throw chatError;
      conversationId = chat.id;
    }

    // Save User Message
    const { error: msgError1 } = await supabase.from('messages').insert({
      chat_id: conversationId,
      user_id: user.id,
      role: 'user',
      content: message
    });
    if (msgError1) throw msgError1;

    // Call Gemini
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      systemInstruction: {
        role: 'system',
        parts: [{ text: finalSystemInstruction }],
      }
    });

    const chat = model.startChat({ history: (history as any) || [] });
    const result = await chat.sendMessage(message);
    const response = result.response.text();

    // Save AI Message
    const { error: msgError2 } = await supabase.from('messages').insert({
      chat_id: conversationId,
      user_id: user.id,
      role: 'model',
      content: response
    });
    if (msgError2) console.error('Failed to save AI message:', msgError2);

    return res.json({ reply: response, conversationId });

  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.format() });
    }
    console.error('consultoria error:', err);
    const errorMessage = err instanceof Error ? err.message : 'Internal server error';
    
    if (errorMessage.includes('API key not valid') || errorMessage.includes('API_KEY_INVALID')) {
      return res.status(500).json({
        error: errorMessage,
        reply: 'Erro de configuração: Chave de API do Gemini inválida ou ausente.'
      });
    }

    return res.status(500).json({ 
      error: errorMessage,
      reply: `Erro interno no servidor.`
    });
  }
});

// Error handling middleware
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: 'Arquivo excede o limite de 5MB.' });
      return;
    }
    res.status(400).json({ error: `Erro no upload: ${err.message}` });
    return;
  }

  if (err instanceof Error && err.message === 'Invalid file type') {
    res.status(400).json({ error: 'Tipo de arquivo inválido. Use .txt, .md, .csv ou .json.' });
    return;
  }

  console.error(err);
  res.status(500).send('Something broke!');
});

const port = process.env.PORT || 3000;
const httpServer = createServer(app);
setupLiveProxy(httpServer);

httpServer.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
