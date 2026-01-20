import express from "express";
import cors from "cors";
import OpenAI from "openai";
import twilio from "twilio";
import { SYSTEM_PROMPT } from "./prompt.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const {
  OPENAI_API_KEY,
  MODEL = "gpt-4.1-mini",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  OWNER_MOBILE_NUMBER
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const twilioClient =
  (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// --- Simple website widget JS served from your app ---
app.get("/widget.js", (req, res) => {
  res.type("application/javascript").send(`
(function(){
  if (window.__prescottsWidgetLoaded) return;
  window.__prescottsWidgetLoaded = true;

  const btn = document.createElement('button');
  btn.innerText = 'Chat';
  btn.setAttribute('aria-label','Open chat');
  btn.style.position='fixed';
  btn.style.right='20px';
  btn.style.bottom='20px';
  btn.style.zIndex='99999';
  btn.style.padding='12px 14px';
  btn.style.borderRadius='999px';
  btn.style.border='0';
  btn.style.cursor='pointer';
  btn.style.boxShadow='0 8px 20px rgba(0,0,0,.2)';

  const panel = document.createElement('div');
  panel.style.position='fixed';
  panel.style.right='20px';
  panel.style.bottom='75px';
  panel.style.width='360px';
  panel.style.maxWidth='calc(100vw - 40px)';
  panel.style.height='520px';
  panel.style.maxHeight='calc(100vh - 120px)';
  panel.style.background='#fff';
  panel.style.borderRadius='16px';
  panel.style.boxShadow='0 10px 30px rgba(0,0,0,.25)';
  panel.style.zIndex='99999';
  panel.style.display='none';
  panel.style.overflow='hidden';
  panel.style.fontFamily='system-ui,-apple-system,Segoe UI,Roboto,Arial';

  panel.innerHTML = \`
    <div style="padding:12px 14px; border-bottom:1px solid #eee; display:flex; justify-content:space-between; align-items:center;">
      <div>
        <div style="font-weight:700;">Laundry Help Bot</div>
        <div style="font-size:12px; color:#555;">Prescott’s Laundry</div>
      </div>
      <button id="pl-close" style="border:0;background:transparent;font-size:18px;cursor:pointer;">✕</button>
    </div>
    <div id="pl-msgs" style="padding:12px; height:400px; overflow:auto; font-size:14px;"></div>
    <div style="padding:10px; border-top:1px solid #eee; display:flex; gap:8px;">
      <input id="pl-input" placeholder="Type a message…" style="flex:1; padding:10px; border:1px solid #ddd; border-radius:10px;" />
      <button id="pl-send" style="padding:10px 12px; border:0; border-radius:10px; cursor:pointer;">Send</button>
    </div>
  \`;

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  const msgs = panel.querySelector('#pl-msgs');
  const input = panel.querySelector('#pl-input');
  const send = panel.querySelector('#pl-send');
  const close = panel.querySelector('#pl-close');

  function addMsg(who, text){
    const div = document.createElement('div');
    div.style.margin='8px 0';
    div.innerHTML = \`<div style="font-size:12px; color:#666;">\${who}</div><div style="white-space:pre-wrap;">\${text}</div>\`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  let thread = [];
  addMsg('Bot', "Hi! 👋 I’m Prescott’s Laundry assistant. I can help with pricing, hours, pickup & delivery, or directions. How can I help?");

  async function ask(){
    const text = input.value.trim();
    if(!text) return;
    input.value='';
    addMsg('You', text);
    thread.push({ role:'user', content:text });

const API_BASE = new URL(document.currentScript.src).origin;

const r = await fetch(API_BASE + '/chat', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ messages: thread })
    });
    const data = await r.json();
    const reply = data?.reply || "Sorry—something went wrong.";
    addMsg('Bot', reply);
    thread.push({ role:'assistant', content: reply });
  }

  btn.onclick = () => { panel.style.display = (panel.style.display==='none') ? 'block' : 'none'; };
  close.onclick = () => { panel.style.display = 'none'; };
  send.onclick = ask;
  input.addEventListener('keydown', (e)=>{ if(e.key==='Enter') ask(); });
})();
  `);
});

// --- Website chat endpoint ---
app.post("/chat", async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages
      ],
      temperature: 0.2
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "";
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: "chat_failed" });
  }
});

// --- Twilio SMS webhook ---
app.post("/twilio/sms", async (req, res) => {
  try {
    const incoming = (req.body?.Body || "").trim();
    const from = req.body?.From;

    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: incoming }
      ],
      temperature: 0.2
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "Sorry—can you rephrase that?";

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    res.type("text/xml").send(twiml.toString());

    // Optional: notify owner on explicit human handoff keywords
    const wantsHuman = /human|person|call me|talk to|representative|owner|manager|help me/i.test(incoming);
    if (wantsHuman && twilioClient && OWNER_MOBILE_NUMBER && TWILIO_NUMBER) {
      await twilioClient.messages.create({
        from: TWILIO_NUMBER,
        to: OWNER_MOBILE_NUMBER,
        body: `Laundry Help Bot: customer ${from} asked for a human. Message: "${incoming}"`
      });
    }
  } catch (e) {
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Sorry—system issue. Please call the store or try again in a minute.");
    res.type("text/xml").send(twiml.toString());
  }
});

app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));

