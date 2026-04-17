const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); 
const cron = require('node-cron');
const { CloudantV1 } = require('@ibm-cloud/cloudant');
const { IamAuthenticator } = require('ibm-cloud-sdk-core');

const app = express();

// Configuração de segurança e parse
app.use(cors());
app.use(express.json());

// =====================================================================
// 1. AUTENTICAÇÃO COM A IBM CLOUD (Cloudant)
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

// Dicionário de Tradução (Sem acentos, pois nossa função limpa tudo)
const dicionarioTimes = {
    "brasil": "brazil",
    "alemanha": "germany",
    "espanha": "spain",
    "franca": "france",
    "inglaterra": "england",
    "holanda": "netherlands",
    "estados unidos": "barcelona", // Mantido para seus testes atuais da Champions
    "coreia do sul": "south korea",
    "japao": "japan",
    "camaroes": "cameroon",
    "suica": "switzerland",
    "servia": "serbia",
    "croacia": "croatia",
    "marrocos": "morocco",
    "africa do sul": "arsenal fc", // Mantido para seus testes atuais
    "mexico": "athletic club", // Mantido para seus testes atuais
    "argentina": "argentina",
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

// Extrai e padroniza a data para YYYY-MM-DD, aceitando o formato em Português do seu site
function formatarDataISO(dataString) {
    if (!dataString) return null;
    
    const dataLower = dataString.toLowerCase();

    // 1. Se vier no formato do site: "Quinta-feira, 11 de Junho de 2026"
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

    // 2. Se vier como DD/MM/YYYY
    if (dataString.includes('/')) {
        const partes = dataString.split('/');
        if (partes.length === 3) {
            return `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
        }
    }
    
    // 3. Se já vier como ISO padrão da API (ex: 2026-06-15T19:00:00Z)
    if (dataString.length >= 10) {
        return dataString.substring(0, 10);
    }
    
    return dataString;
}

// =====================================================================
// 2. O TRABALHADOR INVISÍVEL (CRON JOB) - Recálculo Contínuo
// =====================================================================
cron.schedule('*/1 * * * *', async () => {
    console.log('⚽ Verificando e recalculando resultados (Football-Data.org)...');
    
    try {
        // ATENÇÃO: Está 'CL' (Champions) para testes. Quando for a Copa, troque 'CL' por 'WC'
        const response = await fetch(`https://api.football-data.org/v4/competitions/CL/matches?status=FINISHED`, {
            headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN }
        });
        
        const data = await response.json();
        
        if (data.errorCode) {
            console.log('❌ Erro na API:', data.message);
            return;
        }
        
        const jogosOficiais = data.matches || [];

      // --- ADICIONE ESTE BLOCO AQUI ---
        if (jogosOficiais.length > 0) {
            console.log(`\n--- 🕵️ GABARITO PARA O SEU TESTE ---`);
            console.log(`Coloque no site -> Data: ${formatarDataISO(jogosOficiais[0].utcDate)}`);
            console.log(`Mandante: ${jogosOficiais[0].homeTeam.name} | Visitante: ${jogosOficiais[0].awayTeam.name}`);
            console.log(`Placar que você deve apostar: ${jogosOficiais[0].score.fullTime.home} x ${jogosOficiais[0].score.fullTime.away}`);
            console.log(`-----------------------------------\n`);
        }

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
        console.log(`📂 Recalculando ${cartelas.length} cartelas de usuários...`);

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

                    // Trava 1: Verificação de Data
                    const bateuData = dataPalpite ? (dataPalpite === dataAPI) : true;

                    // Trava 2: Ordem Estrita de Nomes (Mandante x Visitante)
                    const ordemExata = (home.includes(time1Ingles) || time1Ingles.includes(home)) &&
                                       (away.includes(time2Ingles) || time2Ingles.includes(away));

                    if (bateuData && ordemExata) {
                        placarReal1 = j.score.fullTime.home;
                        placarReal2 = j.score.fullTime.away;
                        return true;
                    }
                    return false;
                });

                // Se encontrou o jogo, recalcula os pontos independente de já ter sido pontuado
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

                    // Verifica se a pontuação atualizou
                    if (palpite.pontos_obtidos !== pontosGanhos) {
                        palpite.pontos_obtidos = pontosGanhos;
                        houveMudancaInterna = true;
                    }
                }
                
                pontosTotalCalculado += (palpite.pontos_obtidos || 0);
            });

            // Salva no banco caso alguma pontuação tenha mudado
            if (doc.pontos_acumulados !== pontosTotalCalculado || houveMudancaInterna) {
                doc.pontos_acumulados = pontosTotalCalculado;
                await cloudant.putDocument({ db: DB_NAME, docId: doc._id, document: doc });
            }
        }
        
        console.log('✅ Recálculo contínuo finalizado com sucesso!');
    } catch (error) {
        console.error('❌ Erro no Cron Job:', error);
    }
});

// =====================================================================
// 3. ROTA DE NOTÍCIAS (Proxy Seguro NewsAPI com Filtros)
// =====================================================================
app.get('/noticias', async (req, res) => {
    const API_KEY = '99f3722bea4049eea78883baeada90cd';
    const query = encodeURIComponent('"Copa do Mundo FIFA 2026" -bets -bet -boca -bayern -santos -corinthians -palmeiras -time -aposta -apostas -1958 -1962 -1970 -1994 -1998 -2002 -2006 -2010 -2014 -2018 -2022 -neymar');
    const url = `https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&pageSize=15&apiKey=${API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.status === 'ok' && data.articles) {
            const artigosValidos = data.articles.filter(article => {
                return article.title && 
                       article.title !== '[Removed]' && 
                       article.urlToImage && 
                       article.description;
            });
            data.articles = artigosValidos.slice(0, 5);
        }
        res.json(data);
    } catch (error) {
        console.error("Erro na ponte de notícias:", error);
        res.status(500).json({ status: "error", message: "Falha ao buscar notícias" });
    }
});

// =====================================================================
// 4. ROTAS DO BOLÃO (Apostas, Cartelas e Ranking)
// =====================================================================

// Salvar Palpites em Lote (Cria ou Atualiza a Cartela)
app.post('/salvar-lote', async (req, res) => {
  try {
    const { user_email, user_name, palpites } = req.body;

    const searchResponse = await cloudant.postFind({
      db: DB_NAME,
      selector: {
        type: { "$eq": "cartela_usuario" },
        user_email: { "$eq": user_email }
      }
    });

    const existingDoc = searchResponse.result.docs[0];

    if (existingDoc) {
      // Atualiza a cartela inteira sempre (o cron cuida do recálculo)
      existingDoc.palpites_jogos = palpites;
      existingDoc.user_name = user_name;
      existingDoc.timestamp = new Date().toISOString();

      await cloudant.putDocument({ db: DB_NAME, docId: existingDoc._id, document: existingDoc });
      res.status(200).json({ success: true, message: "Cartela atualizada" });
    } else {
      const novoDocumento = {
        type: "cartela_usuario",
        user_email, user_name, 
        palpites_jogos: palpites,
        pontos_acumulados: 0,
        palpite_final: null,
        timestamp: new Date().toISOString()
      };
      await cloudant.postDocument({ db: DB_NAME, document: novoDocumento });
      res.status(200).json({ success: true, message: "Cartela criada" });
    }
  } catch (error) {
    console.error("Erro /salvar-lote:", error);
    res.status(500).json({ success: false, error: 'Erro ao processar lote' });
  }
});

// Salvar Palpite da Final
app.post('/salvar-final', async (req, res) => {
  try {
    const { user_email, user_name, vencedor_campeonato, placar_final } = req.body;
    const searchResponse = await cloudant.postFind({
      db: DB_NAME,
      selector: { type: { "$eq": "cartela_usuario" }, user_email: { "$eq": user_email } }
    });

    const existingDoc = searchResponse.result.docs[0];
    const dadosDaFinal = { vencedor_campeonato, placar_final };

    if (existingDoc) {
      existingDoc.palpite_final = dadosDaFinal;
      existingDoc.timestamp = new Date().toISOString();
      await cloudant.putDocument({ db: DB_NAME, docId: existingDoc._id, document: existingDoc });
      res.status(200).json({ success: true, message: "Final salva" });
    } else {
      const novoDocumento = {
        type: "cartela_usuario",
        user_email, user_name: user_name || user_email.split('@')[0],
        palpites_jogos: [],
        pontos_acumulados: 0,
        palpite_final: dadosDaFinal,
        timestamp: new Date().toISOString()
      };
      await cloudant.postDocument({ db: DB_NAME, document: novoDocumento });
      res.status(200).json({ success: true, message: "Cartela criada com a final" });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: 'Erro palpite final' });
  }
});

// Gerar o Ranking Geral
app.get('/ranking', async (req, res) => {
  try {
    const response = await cloudant.postFind({
      db: DB_NAME,
      selector: { type: { "$eq": "cartela_usuario" } },
      limit: 2000
    });

    const rankingArray = response.result.docs.map(doc => ({
        email: doc.user_email,
        nome: doc.user_name,
        pontos: doc.pontos_acumulados || 0,
        totalPalpites: doc.palpites_jogos ? doc.palpites_jogos.length : 0
    }));

    rankingArray.sort((a, b) => b.pontos - a.pontos || b.totalPalpites - a.totalPalpites);
    res.status(200).json({ success: true, ranking: rankingArray });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Erro ao gerar ranking' });
  }
});

// Buscar cartela de um usuário para Auto-Preenchimento
app.post('/buscar-cartela', async (req, res) => {
  try {
    const { user_email } = req.body;
    const searchResponse = await cloudant.postFind({
      db: DB_NAME,
      selector: { type: { "$eq": "cartela_usuario" }, user_email: { "$eq": user_email } }
    });

    const existingDoc = searchResponse.result.docs[0];
    res.status(200).json({ success: true, palpites: existingDoc ? (existingDoc.palpites_jogos || []) : [] });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Erro ao buscar cartela' });
  }
});

// =====================================================================
// 5. ROTAS DO FEED SOCIAL (Mural da Resenha, Likes, Replies e Delete)
// =====================================================================

// Postar mensagem principal
app.post('/chat', async (req, res) => {
    try {
        const { user_email, user_name, mensagem } = req.body;
        const novoDocumento = {
            type: "chat_message",
            user_email, user_name, mensagem,
            timestamp: new Date().toISOString(),
            likes: [],  
            replies: [] 
        };
        await cloudant.postDocument({ db: DB_NAME, document: novoDocumento });
        res.status(200).json({ success: true, message: "Mensagem postada!" });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao postar mensagem' });
    }
});

// Buscar feed de mensagens
app.get('/chat', async (req, res) => {
    try {
        const response = await cloudant.postFind({
            db: DB_NAME,
            selector: { type: { "$eq": "chat_message" } },
            limit: 100 
        });
        let mensagens = response.result.docs;
        mensagens.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        res.status(200).json({ success: true, mensagens: mensagens });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao carregar o mural' });
    }
});

// Curtir / Descurtir Mensagem Principal (Toggle)
app.post('/chat/like', async (req, res) => {
    try {
        const { msg_id, user_email } = req.body;
        const doc = (await cloudant.getDocument({ db: DB_NAME, docId: msg_id })).result;
        
        if (!doc.likes) doc.likes = [];
        const index = doc.likes.indexOf(user_email);
        
        if (index > -1) doc.likes.splice(index, 1); 
        else doc.likes.push(user_email); 

        await cloudant.putDocument({ db: DB_NAME, docId: doc._id, document: doc });
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao curtir' });
    }
});

// Postar uma Resposta (Reply)
app.post('/chat/reply', async (req, res) => {
    try {
        const { msg_id, user_email, user_name, mensagem } = req.body;
        const doc = (await cloudant.getDocument({ db: DB_NAME, docId: msg_id })).result;

        if (!doc.replies) doc.replies = [];
        
        doc.replies.push({
            reply_id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
            user_email, 
            user_name, 
            mensagem,
            timestamp: new Date().toISOString(),
            likes: [] 
        });

        await cloudant.putDocument({ db: DB_NAME, docId: doc._id, document: doc });
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao responder' });
    }
});

// Curtir / Descurtir uma Resposta (Reply Like Toggle)
app.post('/chat/reply/like', async (req, res) => {
    try {
        const { msg_id, reply_id, user_email } = req.body;
        const doc = (await cloudant.getDocument({ db: DB_NAME, docId: msg_id })).result;
        const reply = doc.replies.find(r => r.reply_id === reply_id);
        
        if (reply) {
            if (!reply.likes) reply.likes = [];
            const index = reply.likes.indexOf(user_email);
            
            if (index > -1) reply.likes.splice(index, 1); 
            else reply.likes.push(user_email); 
            
            await cloudant.putDocument({ db: DB_NAME, docId: doc._id, document: doc });
        }
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao curtir resposta' });
    }
});

// Apagar um Post Principal
app.post('/chat/delete', async (req, res) => {
    try {
        const { msg_id, user_email } = req.body;
        const doc = (await cloudant.getDocument({ db: DB_NAME, docId: msg_id })).result;

        if (doc.user_email === user_email) {
            await cloudant.deleteDocument({
                db: DB_NAME,
                docId: doc._id,
                rev: doc._rev
            });
            res.status(200).json({ success: true });
        } else {
            res.status(403).json({ success: false, error: 'Não autorizado' });
        }
    } catch (error) {
        console.error("Erro ao apagar:", error);
        res.status(500).json({ success: false, error: 'Erro ao apagar mensagem' });
    }
});

// =====================================================================
// 6. INICIALIZAÇÃO DO SERVIDOR
// =====================================================================
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor Node.js (Bolão + Cron + Chat) rodando na porta ${port}`);
});
