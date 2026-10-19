const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.NVIDIA_API_KEY;
const API_URL = process.env.NVIDIA_API_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-ultra';
const INDEX_PATH = path.join(__dirname, 'index.html');
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PROMPT_CHARS = 8000;
const UPSTREAM_TIMEOUT_MS = 120000;

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('Request body too large'), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            } catch {
                reject(Object.assign(new Error('Body must be valid JSON'), { status: 400 }));
            }
        });
        req.on('error', reject);
    });
}

async function generate(prompt) {
    const upstream = await fetch(API_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 4096,
        }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!upstream.ok) {
        const detail = (await upstream.text()).slice(0, 500);
        throw Object.assign(new Error(`NVIDIA API responded ${upstream.status}: ${detail}`), { status: 502 });
    }

    const data = await upstream.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
        throw Object.assign(new Error('NVIDIA API returned no message content'), { status: 502 });
    }
    return text;
}

async function handleGenerate(req, res) {
    if (!API_KEY) {
        return sendJson(res, 500, { error: 'NVIDIA_API_KEY is not set on the server' });
    }

    const body = await readJsonBody(req);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
        return sendJson(res, 400, { error: 'prompt is required' });
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
        return sendJson(res, 400, { error: `prompt must be ${MAX_PROMPT_CHARS} characters or fewer` });
    }

    const text = await generate(prompt);
    return sendJson(res, 200, { text, model: MODEL });
}

const server = http.createServer(async (req, res) => {
    try {
        const { pathname } = new URL(req.url, 'http://localhost');

        if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return fs.createReadStream(INDEX_PATH).pipe(res);
        }

        if (req.method === 'POST' && pathname === '/api/generate') {
            return await handleGenerate(req, res);
        }

        return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
        const status = err.status || 500;
        if (status === 500) console.error(err);
        if (!res.headersSent) {
            sendJson(res, status, { error: err.message });
        }
    }
});

server.listen(PORT, () => {
    console.log(`App Builder AI listening on http://localhost:${PORT}`);
    console.log(`Model: ${MODEL}`);
    if (!API_KEY) console.warn('Warning: NVIDIA_API_KEY is not set; /api/generate will fail');
});
