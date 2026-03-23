import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

if (process.env.ANTHROPIC_API_KEY) {
  console.log("ANTHROPIC_API_KEY env var loaded (will be overridden by UI key if provided).");
}

// Proxy endpoint to Anthropic
app.post('/api/extract', async (req, res) => {
  const { apiKey, ...anthropicBody } = req.body;
  const resolvedKey = apiKey || process.env.ANTHROPIC_API_KEY;

  const reqSize = JSON.stringify(anthropicBody).length;
  console.log(`[API Request] Size: ${Math.round(reqSize / 1024)}KB`);

  if (!resolvedKey) {
    return res.status(401).json({ error: { message: "Anthropic API key is not configured." } });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": resolvedKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(anthropicBody),
    });

    const data = await response.json().catch(async (e) => {
      const errText = await response.text();
      console.error(`Error parsing Anthropic response: ${errText.substring(0, 200)}`);
      throw new Error(`Invalid JSON from Anthropic: ${errText.substring(0, 100)}`);
    });

    if (!response.ok) {
      console.error("Anthropic API error:", JSON.stringify(data, null, 2));
      return res.status(response.status).json(data);
    }

    console.log(`[API Success] Token usage: ${JSON.stringify(data.usage || "unknown")}`);
    res.json(data);
  } catch (error) {
    console.error("Proxy error:", error.name, ":", error.message);
    res.status(500).json({ error: { message: `Internal server error: ${error.message}` } });
  }
});

// Serve the Vite build
app.use(express.static(path.join(__dirname, 'dist')));

// Fallback to React Router
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
