import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import cron from 'node-cron';
import { CloudantV1 } from '@ibm-cloud/cloudant';
import { IamAuthenticator } from 'ibm-cloud-sdk-core';

const app = express();

// Configuração de segurança e parse
app.use(cors());
app.use(express.json());

// =====================================================================
// 1. CONFIGURAÇÃO DO SERVIDOR MCP (VERSÃO NATIVA SSE)
// =====================================================================

app.get('/mcp', (req, res) => {
    // Configura os headers para manter o "cano" aberto sem erro 502
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    // Envia o endpoint de mensagens que a IBM precisa saber
    const sessionId = Date.now();
    res.write(`event: endpoint\ndata: /mcp/messages?sessionId=${sessionId}\n\n`);

    // Keep-alive: envia um comentário a cada 15s para o Render não dar 502
    const keepAlive = setInterval(() => {
        res.write(': keep-alive\n\n');
    }, 15000);

    req.on('close', () => clearInterval(keepAlive));
});

app.post('/mcp/messages', async (req, res) => {
    const { method, id, params } = req.body;

    // Resposta para a lista de ferramentas
    if (method === 'tools/list') {
        return res.json({
            jsonrpc: "2.0",
            id,
            result: {
                tools: [{
                    name: "get_latest_news_headlines",
                    description: "Busca as manchetes de hoje sobre a Copa 2026",
                    inputSchema: { type: "object", properties: {} }
                }]
            }
        });
    }

    // Resposta para a execução da ferramenta
    if (method === 'tools/call' && params.name === "get_latest_news_headlines") {
        try {
            const API_KEY = '99f3722bea4049eea78883baeada90cd';
            const url = `https://newsapi.org/v2/everything?q=Copa%20do%20Mundo%20FIFA%202026&language=pt&sortBy=publishedAt&pageSize=5&apiKey=${API_KEY}`;
            const response = await fetch(url);
            const data = await response.json();
            const texto = data.articles?.map(a => `- ${a.title}`).join('\n') || "Sem notícias.";

            return res.json({
                jsonrpc: "2.0",
                id,
                result: {
                    content: [{ type: "text", text: `Notícias:\n${texto}` }]
                }
            });
        } catch (e) {
            return res.json({ jsonrpc: "2.0", id, error: { code: -32603, message: "Erro na API" } });
        }
    }

    res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Método não encontrado" } });
});

// =====================================================================
// 2. AUTENTICAÇÃO COM A IBM CLOUD (Cloudant)
// =====================================================================
const authenticator = new IamAuthenticator({
    apikey: process.env.CLOUDANT_APIKEY
});

const cloudant = new CloudantV1({
    authenticator: authenticator
});

cloudant.setServiceUrl(process.env.CLOUDANT_URL);
const DB_NAME = 'palpites_2026';

// =====================================================================
// Configuração API Football-Data.org
// =====================================================================
const FOOTBALL_DATA_TOKEN = '9e96df3fa47d4d9881395f7a1f607370';

const dicionarioTimes = {
    "africa do sul": "south africa", "alemanha": "germany", "arabia saudita": "saudi arabia",
    "argelia": "algeria", "argentina": "argentina", "australia": "australia",
    "austria": "austria", "belgica": "belgium", "bosnia e herzegovina": "bosnia and herzegovina",
    "brasil": "brazil", "cabo verde": "cape verde", "canada": "canada", "catar": "qatar",
    "colombia": "colombia", "costa do marfim": "cote divoire", "croacia": "croatia",
    "curacau": "curacao", "egito": "egypt", "equador": "ecuador", "escocia": "scotland",
    "espanha": "spain", "estados unidos": "united states", "franca": "france",
    "gana": "ghana", "haiti": "haiti", "holanda": "netherlands", "inglaterra": "england",
    "ira": "iran", "iraque": "iraq", "japao": "japan", "jordania": "jordan",
    "marrocos": "morocco", "mexico": "mexico", "noruega": "norway", "nova zelandia": "new zealand",
    "panama": "panama", "paraguai": "paraguay", "portugal": "portugal", "rep da coreia": "south korea",
    "rep dem do congo": "dr congo", "rep tcheca": "czech republic", "senegal": "senegal",
    "suecia": "sweden", "suica": "switzerland", "tunisia": "tunisia", "turquia": "turkey",
    "uruguai": "uruguay", "uzbequistao": "uzbekistan"
};

// =====================================================================
// FUNÇÕES DE LIMPEZA E FORMATAÇÃO
// =====================================================================
function formatarTexto(texto) {
    if (!texto) return '';
    return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/-/g, ' ').replace(/[^\w\s]/gi, '').toLowerCase().trim();
}

function traduzirTime(nomeBR) {
    let nomeLimpo = formatarTexto(nomeBR);
    return dicionarioTimes[nomeLimpo] || nomeLimpo; 
}

function formatarDataISO(dataString) {
    if (!dataString) return null;
    const dataLower = dataString.toLowerCase();
    if (dataLower.includes(' de ')) {
        const meses = { 'janeiro': '01', 'fevereiro': '02', 'março': '03', 'marco': '03', 'abril': '04', 'maio': '05', 'junho': '06', 'julho': '07', 'agosto': '08', 'setembro': '09', 'outubro': '10', 'novembro': '11', 'dezembro': '12' };
        const match = dataLower.match(/(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})/);
        if (match) {
            const dia = match[1].padStart(2, '0');
            const mes = meses[match[2]];
            if (mes) return `${match[3]}-${mes}-${dia}`;
        }
    }
    if (dataString.includes('/')) {
        const partes = dataString.split('/');
        if (partes.length === 3) return `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
    }
    return dataString.length >= 10 ? dataString.substring(0, 10) : dataString;
}

// =====================================================================
// 3. CRON JOB - Recálculo de Resultados
// =====================================================================
cron.schedule('*/10 * * * *', async () => {
    console.log('⚽ Recalculando resultados...');
    try {
        const response = await fetch(`https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED`, {
            headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN }
        });
        const data = await response.json();
        const jogosOficiais = data.matches || [];
        if (jogosOficiais.length === 0) return;

        const userDocs = await cloudant.postFind({ db: DB_NAME, selector: { type: "cartela_usuario" }, limit: 2000 });
        for (let doc of userDocs.result.docs) {
            let pontosTotalCalculado = 0;
            let mudou = false;
            if (!doc.palpites_jogos) continue;

            doc.palpites_jogos.forEach(p => {
                const t1 = traduzirTime(p.time_1);
                const t2 = traduzirTime(p.time_2);
                const dP = formatarDataISO(p.data_jogo);
                const jogo = jogosOficiais.find(j => {
                    const h = formatarTexto(j.homeTeam.name);
                    const a = formatarTexto(j.awayTeam.name);
                    const dA = formatarDataISO(j.utcDate);
                    return dP === dA && ((h.includes(t1) && a.includes(t2)) || (a.includes(t1) && h.includes(t2)));
                });

                if (jogo) {
                    let r1 = jogo.score.fullTime.home, r2 = jogo.score.fullTime.away;
                    if (formatarTexto(jogo.awayTeam.name).includes(t1)) [r1, r2] = [r2, r1];
                    let pts = 0;
                    if (p.placar_1 === r1 && p.placar_2 === r2) pts = 5;
                    else if ((r1>r2 && p.placar_1>p.placar_2) || (r1<r2 && p.placar_1<p.placar_2) || (r1===r2 && p.placar_1===p.placar_2)) pts = 2;
                    if (p.pontos_obtidos !== pts) { p.pontos_obtidos = pts; mudou = true; }
                }
                pontosTotalCalculado += (p.pontos_obtidos || 0);
            });
            if (doc.pontos_acumulados !== pontosTotalCalculado || mudou) {
                doc.pontos_acumulados = pontosTotalCalculado;
                await cloudant.putDocument({ db: DB_NAME, docId: doc._id, document: doc });
            }
        }
    } catch (e) { console.error('Erro Cron:', e); }
});

// =====================================================================
// 4. ROTA DE NOTÍCIAS
// =====================================================================
app.get('/noticias', async (req, res) => {
    const API_KEY = '99f3722bea4049eea78883baeada90cd';
    const url = `https://newsapi.org/v2/everything?q=Copa%20do%20Mundo%20FIFA%202026&language=pt&sortBy=publishedAt&pageSize=50&apiKey=${API_KEY}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.status === 'ok' && data.articles) {
            const black = ['ig', 'terra', 'metrópoles', 'cassino', 'aposta', 'bet', 'feminina', 'lula', 'bolsonaro'];
            let filtrados = data.articles.filter(a => {
                const txt = `${a.title} ${a.description}`.toLowerCase();
                return a.urlToImage && !black.some(b => txt.includes(b) || a.source.name.toLowerCase().includes(b));
            });
            data.articles = filtrados.slice(0, 5);
        }
        res.json(data);
    } catch (e) { res.status(500).json({ error: "Erro notícias" }); }
});

// =====================================================================
// 5. ROTAS DO BOLÃO E CHAT
// =====================================================================
app.post('/salvar-lote', async (req, res) => {
    try {
        const { user_email, user_name, palpites } = req.body;
        const search = await cloudant.postFind({ db: DB_NAME, selector: { type: "cartela_usuario", user_email } });
        const doc = search.result.docs[0];
        if (doc) {
            doc.palpites_jogos = palpites; doc.user_name = user_name; doc.timestamp = new Date().toISOString();
            await cloudant.putDocument({ db: DB_NAME, docId: doc._id, document: doc });
        } else {
            await cloudant.postDocument({ db: DB_NAME, document: { type: "cartela_usuario", user_email, user_name, palpites_jogos: palpites, pontos_acumulados: 0, timestamp: new Date().toISOString() } });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/ranking', async (req, res) => {
    try {
        const r = await cloudant.postFind({ db: DB_NAME, selector: { type: "cartela_usuario" }, limit: 1000 });
        const lista = r.result.docs.map(d => ({ nome: d.user_name, pontos: d.pontos_acumulados || 0 })).sort((a,b) => b.pontos - a.pontos);
        res.json({ success: true, ranking: lista });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/agente-bolao', async (req, res) => {
    const { mensagem, historico } = req.body;
    if (!mensagem) return res.status(400).json({ error: "vazia" });
    try {
        let promptFinal = historico?.length > 0 ? `CONTEXTO:\n${historico.map(m => `[${m.role}]: ${m.content}`).join('\n')}\n\nPERGUNTA: ${mensagem}` : mensagem;
        const response = await fetch(process.env.ICA_AGENT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.ICA_APP_KEY}` },
            body: JSON.stringify({ jsonrpc: "2.0", method: "message/send", params: { message: promptFinal }, id: 1 })
        });
        const data = await response.json();
        res.json({ resposta: data.result });
    } catch (e) { res.status(500).json({ error: "Erro agente" }); }
});

app.post('/chat', async (req, res) => {
    try {
        const { user_email, user_name, mensagem } = req.body;
        await cloudant.postDocument({ db: DB_NAME, document: { type: "chat_message", user_email, user_name, mensagem, timestamp: new Date().toISOString(), likes: [], replies: [] } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/chat', async (req, res) => {
    try {
        const r = await cloudant.postFind({ db: DB_NAME, selector: { type: "chat_message" }, limit: 100 });
        res.json({ success: true, mensagens: r.result.docs.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)) });
    } catch (e) { res.status(500).json({ success: false }); }
});

// =====================================================================
// 6. INICIALIZAÇÃO
// =====================================================================
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${port} com MCP Ativado`);
});
