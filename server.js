const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); 
const cron = require('node-cron');
const { CloudantV1 } = require('@ibm-cloud/cloudant');
const { IamAuthenticator } = require('ibm-cloud-sdk-core');

// Imports para o MCP
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const app = express();

// Configuração de segurança e parse
app.use(cors());
app.use(express.json());

// =====================================================================
// 1. CONFIGURAÇÃO DO SERVIDOR MCP (Model Context Protocol)
// =====================================================================
const mcpServer = new Server({
    name: "bolao-mcp-server",
    version: "1.0.0"
}, {
    capabilities: {
        tools: {}
    }
});

// Lista de ferramentas que aparecerão no painel da IBM
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "get_latest_news_headlines",
                description: "Busca as manchetes mais recentes sobre a Copa 2026 filtradas pelo seu servidor.",
                inputSchema: {
                    type: "object",
                    properties: {
                        limit: { type: "number", description: "Quantidade de notícias (máx 5)" }
                    }
                }
            }
        ]
    };
});

// Lógica de execução da ferramenta
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "get_latest_news_headlines") {
        try {
            // Simulamos uma chamada interna para a sua própria rota de notícias
            const newsResponse = await fetch(`http://localhost:${process.env.PORT || 8080}/noticias`);
            const newsData = await newsResponse.json();
            
            const textoNoticias = newsData.articles.map(a => `- ${a.title}`).join('\n');
            
            return {
                content: [{ type: "text", text: `Aqui estão as últimas notícias que encontrei:\n${textoNoticias}` }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: "Não consegui acessar as notícias agora." }],
                isError: true
            };
        }
    }
    throw new Error("Ferramenta não encontrada");
});

// Endpoint SSE para a IBM conectar
let transport;
app.get('/mcp', async (req, res) => {
    transport = new SSEServerTransport("/mcp/messages", res);
    await mcpServer.connect(transport);
});

app.post('/mcp/messages', async (req, res) => {
    if (transport) {
        await transport.handlePostMessage(req, res);
    }
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

// Dicionário Oficial - Copa do Mundo 2026 (Sem acentos do lado esquerdo)
const dicionarioTimes = {
    "africa do sul": "south africa",
    "alemanha": "germany",
    "arabia saudita": "saudi arabia",
    "arabia saudita": "saudi arabia",
    "argelia": "algeria",
    "argentina": "argentina",
    "australia": "australia",
    "austria": "austria",
    "belgica": "belgium",
    "bosnia e herzegovina": "bosnia and herzegovina",
    "brasil": "brazil",
    "cabo verde": "cape verde",
    "canada": "canada",
    "catar": "qatar",
    "colombia": "colombia",
    "costa do marfim": "cote divoire",
    "croacia": "croatia",
    "curacau": "curacao",
    "egito": "egypt",
    "equador": "ecuador",
    "escocia": "scotland",
    "espanha": "spain",
    "estados unidos": "united states",
    "franca": "france",
    "gana": "ghana",
    "haiti": "haiti",
    "holanda": "netherlands",
    "inglaterra": "england",
    "ira": "iran",
    "iraque": "iraq",
    "japao": "japan",
    "jordania": "jordan",
    "marrocos": "morocco",
    "mexico": "mexico",
    "noruega": "norway",
    "nova zelandia": "new zealand",
    "panama": "panama",
    "paraguai": "paraguay",
    "portugal": "portugal",
    "rep da coreia": "south korea",
    "rep dem do congo": "dr congo",
    "rep tcheca": "czech republic",
    "senegal": "senegal",
    "suecia": "sweden",
    "suica": "switzerland",
    "tunisia": "tunisia",
    "turquia": "turkey",
    "uruguai": "uruguay",
    "uzbequistao": "uzbekistan"
};

// =====================================================================
// FUNÇÕES DE LIMPEZA E FORMATAÇÃO (Texto e Datas)
// =====================================================================
function formatarTexto(texto) {
    if (!texto) return '';
    return texto.normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '') 
                .replace(/-/g, ' ') 
                .replace(/[^\w\s]/gi, '') 
                .toLowerCase()
                .trim();
}

function traduzirTime(nomeBR) {
    let nomeLimpo = formatarTexto(nomeBR);
    return dicionarioTimes[nomeLimpo] || nomeLimpo; 
}

function formatarDataISO(dataString) {
    if (!dataString) return null;
    
    const dataLower = dataString.toLowerCase();

    if (dataLower.includes(' de ')) {
        const meses = {
            'janeiro': '01', 'fevereiro': '02', 'março': '03', 'marco': '03',
            'abril': '04', 'maio': '05', 'junho': '06',
            'julho': '07', 'agosto': '08', 'setembro': '09',
            'outubro': '10', 'novembro': '11', 'dezembro': '12'
        };

        const match = dataLower.match(/(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})/);

        if (match) {
            const dia = match[1].padStart(2, '0');
            const mesNome = match[2];
            const ano = match[3];
            const mes = meses[mesNome];

            if (mes) {
                return `${ano}-${mes}-${dia}`;
            }
        }
    }

    if (dataString.includes('/')) {
        const partes = dataString.split('/');
        if (partes.length === 3) {
            return `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
        }
    }
    
    if (dataString.length >= 10) {
        return dataString.substring(0, 10);
    }
    
    return dataString;
}

// =====================================================================
// 3. O TRABALHADOR INVISÍVEL (CRON JOB) - Recálculo Contínuo
// =====================================================================
cron.schedule('*/10 * * * *', async () => {
    console.log('⚽ Verificando e recalculando resultados (World Cup)...');
    
    try {
        const response = await fetch(`https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED`, {
            headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN }
        });
        
        const data = await response.json();
        
        if (data.errorCode) {
            console.log('❌ Erro na API:', data.message);
            return;
        }
        
        const jogosOficiais = data.matches || [];

        if (jogosOficiais.length === 0) {
            console.log('Nenhum jogo novo finalizado no momento.');
            return;
        }
        
        const userDocs = await cloudant.postFind({
            db: DB_NAME,
            selector: { type: { "$eq": "cartela_usuario" } },
            limit: 2000
        });

        const cartelas = userDocs.result.docs;

        for (let doc of cartelas) {
            let pontosTotalCalculado = 0;
            let houveMudancaInterna = false; 

            if (!doc.palpites_jogos || doc.palpites_jogos.length === 0) continue;

            doc.palpites_jogos.forEach(palpite => {
                const time1Ingles = traduzirTime(palpite.time_1);
                const time2Ingles = traduzirTime(palpite.time_2);
                const dataPalpite = formatarDataISO(palpite.data_jogo);

                let placarReal1 = null;
                let placarReal2 = null;

                const jogoOficial = jogosOficiais.find(j => {
                    const home = formatarTexto(j.homeTeam.name);
                    const away = formatarTexto(j.awayTeam.name);
                    const dataAPI = formatarDataISO(j.utcDate);

                    const bateuData = dataPalpite ? (dataPalpite === dataAPI) : true;

                    const ordemExata = (home.includes(time1Ingles) || time1Ingles.includes(home)) &&
                                       (away.includes(time2Ingles) || time2Ingles.includes(away));

                    const ordemInvertida = (away.includes(time1Ingles) || time1Ingles.includes(away)) &&
                                           (home.includes(time2Ingles) || time2Ingles.includes(home));

                    if (bateuData) {
                        if (ordemExata) {
                            placarReal1 = j.score.fullTime.home;
                            placarReal2 = j.score.fullTime.away;
                            return true;
                        } else if (ordemInvertida) {
                            placarReal1 = j.score.fullTime.away;
                            placarReal2 = j.score.fullTime.home;
                            return true;
                        }
                    }
                    return false;
                });

                if (jogoOficial) {
                    const palpite1 = palpite.placar_1;
                    const palpite2 = palpite.placar_2;

                    let pontosGanhos = 0;

                    if (palpite1 === placarReal1 && palpite2 === placarReal2) {
                        pontosGanhos = 5; 
                    } else {
                        const vencedorReal = placarReal1 > placarReal2 ? 1 : (placarReal1 < placarReal2 ? 2 : 0);
                        const vencedorPalpite = palpite1 > palpite2 ? 1 : (palpite1 < palpite2 ? 2 : 0);
                        if (vencedorReal === vencedorPalpite) pontosGanhos = 2; 
                    }

                    if (palpite.pontos_obtidos !== pontosGanhos) {
                        palpite.pontos_obtidos = pontosGanhos;
                        houveMudancaInterna = true;
                    }
                }
                
                pontosTotalCalculado += (palpite.pontos_obtidos || 0);
            });

            if (doc.pontos_acumulados !== pontosTotalCalculado || houveMudancaInterna) {
                doc.pontos_acumulados = pontosTotalCalculado;
                await cloudant.putDocument({ db: DB_NAME, docId: doc._id, document: doc });
            }
        }
    } catch (error) {
        console.error('❌ Erro no Cron Job:', error);
    }
});

// =====================================================================
// 4. ROTA DE NOTÍCIAS (Proxy Seguro NewsAPI)
// =====================================================================
app.get('/noticias', async (req, res) => {
    const API_KEY = '99f3722bea4049eea78883baeada90cd';
    const query = encodeURIComponent('Copa do Mundo FIFA 2026');
    const url = `https://newsapi.org/v2/everything?q=${query}&language=pt&sortBy=publishedAt&pageSize=50&apiKey=${API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.status === 'ok' && data.articles && data.articles.length > 0) {
            const proibidoSites = ['ig', 'terra', 'metrópoles', 'metropoles', 'diariodocentrodomundo', 'pragmatismopolitico', 'abril'];
            const temPalavra = (texto, lista) => lista.some(palavra => texto.includes(palavra));

            let artigosValidos = data.articles.filter(article => {
                const titulo = article.title ? article.title.toLowerCase() : '';
                const desc = article.description ? article.description.toLowerCase() : '';
                const textoCompleto = `${titulo} ${desc}`; 
                const sourceName = article.source?.name?.toLowerCase() || '';
                const basicoOk = article.title && article.title !== '[Removed]' && article.urlToImage && article.description;
                const falaDeCopa = textoCompleto.includes('copa') || textoCompleto.includes('mundial') || textoCompleto.includes('fifa');
                
                return basicoOk && falaDeCopa && !proibidoSites.some(site => sourceName.includes(site));
            });
            
            data.articles = artigosValidos.slice(0, 5);
        } else {
            data.articles = []; 
        }
        res.json(data);
    } catch (error) {
        res.status(500).json({ status: "error", message: "Falha interna" });
    }
});

// =====================================================================
// 5. ROTAS DO BOLÃO (Apostas, Cartelas e Ranking)
// =====================================================================
app.post('/salvar-lote', async (req, res) => {
  try {
    const { user_email, user_name, palpites } = req.body;
    const searchResponse = await cloudant.postFind({
      db: DB_NAME,
      selector: { type: { "$eq": "cartela_usuario" }, user_email: { "$eq": user_email } }
    });
    const existingDoc = searchResponse.result.docs[0];
    if (existingDoc) {
      existingDoc.palpites_jogos = palpites;
      existingDoc.user_name = user_name;
      existingDoc.timestamp = new Date().toISOString();
      await cloudant.putDocument({ db: DB_NAME, docId: existingDoc._id, document: existingDoc });
      res.status(200).json({ success: true });
    } else {
      const novoDocumento = { type: "cartela_usuario", user_email, user_name, palpites_jogos: palpites, pontos_acumulados: 0, timestamp: new Date().toISOString() };
      await cloudant.postDocument({ db: DB_NAME, document: novoDocumento });
      res.status(200).json({ success: true });
    }
  } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/ranking', async (req, res) => {
  try {
    const response = await cloudant.postFind({ db: DB_NAME, selector: { type: { "$eq": "cartela_usuario" } }, limit: 2000 });
    const rankingArray = response.result.docs.map(doc => ({
        email: doc.user_email, nome: doc.user_name, pontos: doc.pontos_acumulados || 0
    }));
    rankingArray.sort((a, b) => b.pontos - a.pontos);
    res.status(200).json({ success: true, ranking: rankingArray });
  } catch (error) { res.status(500).json({ success: false }); }
});

// =====================================================================
// 6. ROTA DO AGENTE DE IA NATIVO
// =====================================================================
app.post('/agente-bolao', async (req, res) => {
    const { mensagem, historico } = req.body;
    if (!mensagem) return res.status(400).json({ error: "Mensagem vazia." });

    try {
        const agenteEndpoint = process.env.ICA_AGENT_URL; 
        let promptFinal = historico && historico.length > 0 ? `CONTEXTO: ${JSON.stringify(historico)}\nPERGUNTA: ${mensagem}` : mensagem;

        const rpcPayload = {
            jsonrpc: "2.0",
            method: "message/send", 
            params: { message: promptFinal },
            id: 1 
        };

        const response = await fetch(agenteEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.ICA_APP_KEY}` 
            },
            body: JSON.stringify(rpcPayload)
        });

        const data = await response.json();
        res.json({ resposta: data.result }); 
    } catch (error) {
        res.status(500).json({ error: "Erro no agente." });
    }
});

// =====================================================================
// 7. INICIALIZAÇÃO DO SERVIDOR
// =====================================================================
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor Node.js (Bolão + MCP) rodando na porta ${port}`);
});
