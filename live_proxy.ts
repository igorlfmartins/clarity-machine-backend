import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'http';
import { UNIFIED_AGENT_PROMPT, TONE_INSTRUCTIONS } from './agents.js';
import { supabase } from './supabase.js';
import { env } from './config/env.js';

const GOOGLE_LIVE_API_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.MultimodalLive';

export function setupLiveProxy(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request, socket, head) => {
    try {
      const host = request.headers.host || 'localhost';
      const url = new URL(request.url || '', `http://${host}`);

      if (url.pathname === '/api/live') {
        const token = url.searchParams.get('token');
        
        if (!token) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      }
    } catch (err) {
      console.error('WebSocket upgrade error:', err);
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    console.log('Live mode client connected');

    const googleUrl = `${GOOGLE_LIVE_API_URL}?key=${env.GEMINI_API_KEY}`;
    const googleWs = new WebSocket(googleUrl);

    // Track connection state
    let isGoogleWsOpen = false;

    googleWs.on('open', () => {
      console.log('Connected to Gemini Live API');
      isGoogleWsOpen = true;
    });

    googleWs.on('message', (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    googleWs.on('error', (err: any) => {
      console.error('Gemini API Error:', err.message);
      ws.close(1011, 'Upstream Error');
    });

    googleWs.on('close', (code, reason) => {
      console.log(`Gemini API closed: ${code}`);
      isGoogleWsOpen = false;
      ws.close();
    });

    ws.on('message', (data) => {
      if (!isGoogleWsOpen) {
        // Queue or ignore if upstream not ready
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        if (msg.setup) {
          const baseInstruction = msg.setup.system_instruction?.parts?.[0]?.text || UNIFIED_AGENT_PROMPT;
          const toneInstruction = TONE_INSTRUCTIONS.level1;
          
          msg.setup.system_instruction = {
            parts: [{ 
              text: `${baseInstruction}\n\n${toneInstruction}\n\nIMPORTANT: Voice Mode. Be concise and natural.` 
            }]
          };
          
          googleWs.send(JSON.stringify(msg));
          return;
        }
      } catch (e) {
        // Forward raw data (audio)
      }
      
      googleWs.send(data);
    });

    ws.on('error', (err) => {
      console.error('Frontend WS Error:', err);
      googleWs.close();
    });

    ws.onclose = () => {
      console.log('Frontend WS closed');
      googleWs.close();
    };
  });
}
