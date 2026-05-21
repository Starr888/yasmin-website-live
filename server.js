import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

const PORT = Number(process.env.PORT || 8080);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const GEMINI_VOICE_NAME = process.env.GEMINI_VOICE_NAME || 'Kore';
if (!GEMINI_API_KEY) { console.error('Missing GEMINI_API_KEY'); process.exit(1); }

const app = express();
app.use(express.json({ limit: '1mb' }));

const rooms = new Map();
const ipLastComment = new Map();
let globalLastComment = 0;

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (origin.includes('xqueenx.com') || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (_req, res) => res.type('text/plain').send(`Yasmin Website Live Server OK\nModel: ${GEMINI_LIVE_MODEL}\nVoice: ${GEMINI_VOICE_NAME}\n`));
app.get('/health', (_req, res) => res.json({ ok:true, rooms:Array.from(rooms.keys()).map(room=>({room, displays:rooms.get(room).displays.size, controls:rooms.get(room).controls.size})) }));

const server = app.listen(PORT, () => console.log(`Yasmin Website Live Server listening on ${PORT}`));
const wss = new WebSocketServer({ server });
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

function getRoom(roomId='website_yasmin'){
  if(!rooms.has(roomId)) rooms.set(roomId,{id:roomId,displays:new Set(),controls:new Set(),geminiSession:null,ready:false,pending:[]});
  return rooms.get(roomId);
}
function safeSend(client,payload){try{if(client.readyState===1)client.send(JSON.stringify(payload));}catch{}}
function broadcast(clients,payload){for(const c of clients)safeSend(c,payload)}
function cleanText(v,max=3000){return typeof v==='string'?v.trim().replace(/\s+/g,' ').slice(0,max):''}
function isBadComment(t){const l=String(t||'').toLowerCase();if(/https?:\/\//i.test(t))return true;return ['kill yourself','suicide','terrorist','bomb','drug','nude','porn','sex','onlyfans','hack','password','api key'].some(w=>l.includes(w));}

function systemPrompt(){
return `You are Yasmin, a virtual AI host for the MAMA X website live stream.
You are a virtual AI host, not a real private person.
If viewers ask what you are, say: "I'm Yasmin, a virtual AI host for this live."
If viewers ask where you are from, say: "I'm a virtual Arab-style host currently live from Taiwan."
Do NOT speak Khmer.
Use only English, Thai, Indonesian, Spanish, Arabic, or Chinese.
Match the viewer's language if it is one of those languages.
If Khmer or unsupported language, reply in simple English.
Be sweet, friendly, playful, warm, feminine, confident, and fun.
Good topics: history, woman beauty, love, Taiwan, music, travel, food, daily life, and fun questions.
Do not keep saying subscribe, VIP, Queen X, or private videos.
Only mention VIP/subscription if the viewer directly asks.
One short sentence only, 6 to 16 words maximum.
Keep everything safe and suitable for public live stream.`;
}

async function startGemini(room){
 if(room.geminiSession)return room.geminiSession;
 room.ready=false;broadcast(room.controls,{type:'status',message:'Connecting Yasmin voice...'});
 room.geminiSession=await ai.live.connect({
  model:GEMINI_LIVE_MODEL,
  config:{responseModalities:[Modality.AUDIO],systemInstruction:{parts:[{text:systemPrompt()}]},outputAudioTranscription:{},speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:GEMINI_VOICE_NAME}}}},
  callbacks:{
   onopen:()=>{room.ready=true;broadcast(room.controls,{type:'status',message:'Yasmin voice connected.'});const p=room.pending.splice(0);for(const input of p){try{room.geminiSession.sendRealtimeInput(input)}catch{}}},
   onmessage:(message)=>{
    const content=message.serverContent;
    if(content?.outputTranscription?.text)broadcast(room.controls,{type:'text',text:content.outputTranscription.text});
    if(content?.modelTurn?.parts){for(const part of content.modelTurn.parts){if(part.inlineData?.data)broadcast(room.displays,{type:'audio',data:part.inlineData.data,mimeType:part.inlineData.mimeType||'audio/pcm;rate=24000'});if(part.text)broadcast(room.controls,{type:'text',text:part.text});}}
    if(content?.turnComplete){broadcast(room.displays,{type:'turn_complete'});broadcast(room.controls,{type:'status',message:'Answer complete.'});}
   },
   onerror:(e)=>broadcast(room.controls,{type:'error',message:e?.message||String(e)}),
   onclose:()=>{room.ready=false;room.geminiSession=null;broadcast(room.controls,{type:'status',message:'Gemini voice closed.'});}
  }
 });
 return room.geminiSession;
}
async function sendToGemini(room,input){await startGemini(room);if(room.ready&&room.geminiSession)room.geminiSession.sendRealtimeInput(input);else room.pending.push(input)}

function buildCommentPrompt(name,comment){
 return `Website viewer "${name}" commented: "${comment}". Reply as Yasmin, a virtual AI host for MAMA X website live. Do not speak Khmer. Use English, Thai, Indonesian, Spanish, Arabic, or Chinese. If unsupported language, reply in simple English. Be sweet, friendly, playful, and natural. One short sentence only, 6 to 16 words. Do not promote subscription, VIP, Queen X, or private videos unless directly asked.`;
}

app.post('/api/public-comment',async(req,res)=>{
 try{
  const ip=req.headers['x-forwarded-for']?.split(',')[0]?.trim()||req.socket.remoteAddress||'unknown';
  const now=Date.now();
  if(now-(ipLastComment.get(ip)||0)<15000)return res.status(429).json({ok:false,error:'Please wait before sending another comment.'});
  if(now-globalLastComment<3000)return res.status(429).json({ok:false,error:'Yasmin is answering another viewer. Try again soon.'});
  const roomId=cleanText(req.body?.room||'website_yasmin',80)||'website_yasmin';
  const name=cleanText(req.body?.name||'Guest',40)||'Guest';
  const comment=cleanText(req.body?.comment||'',220);
  if(!comment||comment.length<2)return res.status(400).json({ok:false,error:'Comment is empty.'});
  if(isBadComment(comment))return res.status(400).json({ok:false,error:'Comment blocked by safety filter.'});
  ipLastComment.set(ip,now);globalLastComment=now;
  const room=getRoom(roomId);
  broadcast(room.controls,{type:'status',message:`Website comment from ${name}: ${comment}`});
  await sendToGemini(room,{text:buildCommentPrompt(name,comment)});
  res.json({ok:true});
 }catch(err){res.status(500).json({ok:false,error:err?.message||String(err)})}
});

wss.on('connection',(client)=>{
 let currentRoomId='website_yasmin',role='unknown';
 safeSend(client,{type:'status',message:'Connected to Yasmin website live server.'});
 client.on('message',async(raw)=>{
  try{
   const msg=JSON.parse(raw.toString());
   currentRoomId=cleanText(msg.room||currentRoomId||'website_yasmin',80)||'website_yasmin';
   const room=getRoom(currentRoomId);
   if(msg.type==='setup_display'){role='display';room.displays.add(client);safeSend(client,{type:'status',message:`Display connected to room ${currentRoomId}.`});broadcast(room.controls,{type:'status',message:`Display connected. Displays: ${room.displays.size}`});return}
   if(msg.type==='setup_control'){role='control';room.controls.add(client);safeSend(client,{type:'status',message:`Control connected to room ${currentRoomId}. Displays online: ${room.displays.size}`});return}
   if(msg.type==='text'){const text=cleanText(msg.text,2000);if(!text)return;await sendToGemini(room,{text});return}
   if(msg.type==='control_comment'){const text=cleanText(msg.text,1000);if(!text)return;await sendToGemini(room,{text:buildCommentPrompt('Viewer',text)});return}
   safeSend(client,{type:'error',message:`Unknown message type: ${String(msg.type||'')}`});
  }catch(err){safeSend(client,{type:'error',message:err?.message||String(err)})}
 });
 client.on('close',()=>{const room=getRoom(currentRoomId);if(role==='display')room.displays.delete(client);if(role==='control')room.controls.delete(client);broadcast(room.controls,{type:'status',message:`Client disconnected. Displays: ${room.displays.size}, Controls: ${room.controls.size}`})});
});
