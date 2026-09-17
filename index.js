import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { downloadTikTokVideo, downloadFacebookVideo, downloadYouTubeVideo } from 'speedydl';
import fs from 'fs';
import path from 'path';

dotenv.config();

// 1. GitHub Secrets හරහා Auto Session Restore කිරීම
if (process.env.SESSION_BASE64) {
    try {
        if (!fs.existsSync('auth_info')) {
            fs.mkdirSync('auth_info', { recursive: true });
        }
        const sessionData = Buffer.from(process.env.SESSION_BASE64, 'base64').toString('utf-8');
        const parsed = JSON.parse(sessionData);
        for (const [file, content] of Object.entries(parsed)) {
            fs.writeFileSync(path.join('auth_info', file), JSON.stringify(content));
        }
        console.log('✅ Session restored successfully from SESSION_BASE64!');
    } catch (e) {
        console.error('❌ Failed to restore session:', e.message);
    }
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const chatSessions = new Map();

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        
        // අලුතින් QR scan කළ පසු session එක Base64 ලෙස Export කර පෙන්වයි
        try {
            const files = fs.readdirSync('auth_info');
            const sessionObj = {};
            for (const file of files) {
                sessionObj[file] = JSON.parse(fs.readFileSync(path.join('auth_info', file), 'utf-8'));
            }
            const base64 = Buffer.from(JSON.stringify(sessionObj)).toString('base64');
            console.log('\n================ SESSION BASE64 STRING ================');
            console.log(base64);
            console.log('========================================================\n');
        } catch (err) {
            // Ignore temporary save read errors
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('📱 QR Code එක පහතින් Scan කරන්න:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('සම්බන්ධතාවය විසන්ධි විය. නැවත සම්බන්ධ වෙමින්...', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('⚡ Aira WhatsApp Multi-Feature AI Bot is Active on GitHub Actions!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const messageType = Object.keys(msg.message)[0];
        
        const isImage = messageType === 'imageMessage';
        const isAudio = messageType === 'audioMessage';
        
        const caption = msg.message.imageMessage?.caption || '';
        const rawText = msg.message.conversation || msg.message.extendedTextMessage?.text || caption;
        const text = rawText.trim();
        const lowerText = text.toLowerCase();

        // Downloader
        if (text.includes('tiktok.com') || text.includes('facebook.com') || text.includes('fb.watch') || text.includes('youtube.com') || text.includes('youtu.be')) {
            await sock.sendMessage(sender, { text: '📥 වීඩියෝව Download වෙමින් පවතී...' }, { quoted: msg });

            try {
                if (text.includes('tiktok.com')) {
                    const videoData = await downloadTikTokVideo(text);
                    if (videoData?.hd || videoData?.sd) {
                        await sock.sendMessage(sender, { video: { url: videoData.hd || videoData.sd }, caption: '🎬 *TikTok Video*' }, { quoted: msg });
                        return;
                    }
                } else if (text.includes('facebook.com') || text.includes('fb.watch')) {
                    const videoData = await downloadFacebookVideo(text);
                    if (videoData?.hd || videoData?.sd) {
                        await sock.sendMessage(sender, { video: { url: videoData.hd || videoData.sd }, caption: '🎬 *Facebook Video*' }, { quoted: msg });
                        return;
                    }
                } else if (text.includes('youtube.com') || text.includes('youtu.be')) {
                    const videoData = await downloadYouTubeVideo(text);
                    if (videoData?.url) {
                        await sock.sendMessage(sender, { video: { url: videoData.url }, caption: '🎬 *YouTube Video*' }, { quoted: msg });
                        return;
                    }
                }
            } catch (err) {
                await sock.sendMessage(sender, { text: '❌ වීඩියෝව Download කිරීමට නොහැකි විය.' }, { quoted: msg });
                return;
            }
        }

        // Commands
        if (text.startsWith('/')) {
            const args = text.split(' ');
            const command = args[0].toLowerCase();

            if (command === '/start') {
                await sock.sendMessage(sender, { 
                    text: '👋 *Aira AI Assistant Active!*\n\n- "Aira [ප්‍රශ්නය]" යවා Chat කරන්න\n- Link යවා Video Download කරගන්න' 
                });
                return;
            }

            if (command === '/img') {
                const prompt = args.slice(1).join(' ');
                if (!prompt) return;

                try {
                    const response = await ai.models.generateImages({
                        model: 'imagen-3.0-generate-002',
                        prompt: prompt,
                        config: { numberOfImages: 1, outputMimeType: 'image/jpeg' },
                    });
                    const base64Image = response.generatedImages[0].image.imageBytes;
                    const imageBuffer = Buffer.from(base64Image, 'base64');
                    await sock.sendMessage(sender, { image: imageBuffer, caption: `🎨 *${prompt}*` }, { quoted: msg });
                } catch (err) {
                    await sock.sendMessage(sender, { text: '❌ Image සාදා ගැනීමට නොහැකි විය.' });
                }
                return;
            }
        }

        // Media Parsing
        if ((isImage || isAudio) && lowerText.includes('aira')) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const mimeType = isImage ? msg.message.imageMessage.mimetype : msg.message.audioMessage.mimetype;

                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: [
                        { inlineData: { data: buffer.toString('base64'), mimeType: mimeType } },
                        text || 'මේ පිළිබඳ විස්තර කරන්න.'
                    ]
                });
                await sock.sendMessage(sender, { text: response.text }, { quoted: msg });
            } catch (err) {
                await sock.sendMessage(sender, { text: '❌ Media එක Read කිරීමට නොහැකි විය.' });
            }
            return;
        }

        // AI Chat
        if (lowerText.includes('aira')) {
            try {
                if (!chatSessions.has(sender)) {
                    const session = ai.chats.create({
                        model: 'gemini-2.5-flash',
                        config: { systemInstruction: 'ඔබේ නම Aira. ඔබ WhatsApp AI Assistant කෙනෙකි.' }
                    });
                    chatSessions.set(sender, session);
                }
                const chat = chatSessions.get(sender);
                const response = await chat.sendMessage({ message: text });
                await sock.sendMessage(sender, { text: response.text }, { quoted: msg });
            } catch (error) {
                await sock.sendMessage(sender, { text: 'පිළිතුරු දීමට නොහැකි විය.' });
            }
        }
    });
}

startBot();
