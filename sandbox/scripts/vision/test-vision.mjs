import fs from 'fs';
const imageBase64 = fs.readFileSync('games/minecraft/screenshots/minecraft-1000-bedrock-20260309_002554.png').toString('base64');
const res = await fetch('http://192.168.1.33:11434/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: "qwen3.5:27b",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } }
      ]
    }]
  })
});
console.log(res.status, await res.text());
