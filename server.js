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

// Dicionário de Tradução (Português do Front-end -> Inglês da API)
// Quando sair o sorteio oficial dos 48 times, basta completar esta lista!
const dicionarioTimes = {
    "brasil": "brazil",
    "alemanha": "germany",
    "espanha": "spain",
    "frança": "france",
    "inglaterra": "england",
    "holanda": "netherlands",
    "estados unidos": "barcelona",
    "coreia do sul": "south korea",
    "japão": "japan",
    "camarões": "cameroon",
    "suíça": "switzerland",
    "sérvia": "serbia",
    "croácia": "croatia",
    "marrocos": "morocco",
    "áfrica do sul": "FC Barcelona",
    "méxico": "Paris Saint-Germain FC",
    "argentina": "argentina",
};

// Função que traduz o nome e arranca Emojis/Bandeiras antes de procurar
function traduzirTime(nomeBR) {
    // 1. O código mágico /[^...]/gu arranca tudo que não for Letra ou Número
    let nomeLimpo = nomeBR.replace(/[^\p{L}\p{N}\s]/gu, '').toLowerCase().trim();
    
    // 2. Procura no dicionário
    return dicionarioTimes[nomeLimpo] || nomeLimpo; 
}

// =====================================================================
// 2. O TRABALHADOR INVISÍVEL (CRON JOB) - Roda a cada 10 minutos
// =====================================================================
cron.schedule('*/2 * * * *', async () => {
    console.log('⚽ Verificando resultados na Football-Data.org...');
    
    try {
        // Busca jogos da Copa do Mundo ('WC') que já terminaram ('FINISHED')
        // Trocamos 'WC' por 'CL' (Champions League) e removemos o season=2022
        const response = await fetch(`https://api.football-data.org/v4/competitions/CL/matches?status=FINISHED`, {
            headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN }
        });
        
        const data = await response.json();
        console.log(`📊 Achamos ${data.matches ? data.matches.length : 0} jogos finalizados!`);
        // Raio-X de Erros
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
            selector: { type: { "$eq": "cartela_usuario" } }
        });

        const cartelas = userDocs.result.docs;

        for (let doc of cartelas) {
            let pontosTotal = 0;
            let houveMudanca = false;

            if (!doc.palpites_jogos) continue;

            doc.palpites_jogos.forEach(palpite => {
                // 1. Traduz os times do palpite para inglês
                const time1Ingles = traduzirTime(palpite.time_1);
                const time2Ingles = traduzirTime(palpite.time_2);

                // =======================================================
                // 🕵️ RAIO-X MÁXIMO (Adicione este bloco aqui!)
                // =======================================================
                console.log(`\n--- 🔍 INSPECIONANDO CARTELA ---`);
                console.log(`📝 O que veio do seu site: [${palpite.time_1}] x [${palpite.time_2}]`);
                console.log(`🗣️ Como o Dicionário leu: [${time1Ingles}] x [${time2Ingles}]`);
                console.log(`⚽ O que a API da Football-Data respondeu hoje:`);
                jogosOficiais.forEach(j => {
                    console.log(`   -> [${j.homeTeam.name}] x [${j.awayTeam.name}]`);
                });
                console.log(`--------------------------------\n`);
                // =======================================================

                let placarReal1 = null;
                let placarReal2 = null;

                // 2. Faz a busca super-inteligente (Lê nas duas direções)
                const jogoOficial = jogosOficiais.find(j => {
                    const home = j.homeTeam.name.toLowerCase();
                    const away = j.awayTeam.name.toLowerCase();

                    // Cenário A: A ordem da API é igual a do usuário
                    const ordemExata = (home.includes(time1Ingles) || time1Ingles.includes(home)) &&
                                       (away.includes(time2Ingles) || time2Ingles.includes(away));

                    // Cenário B: A ordem da API está invertida (Time 2 em casa, Time 1 fora)
                    const ordemInvertida = (away.includes(time1Ingles) || time1Ingles.includes(away)) &&
                                           (home.includes(time2Ingles) || time2Ingles.includes(home));

                    if (ordemExata) {
                        placarReal1 = j.score.fullTime.home;
                        placarReal2 = j.score.fullTime.away;
                        return true;
                    } else if (ordemInvertida) {
                        // Se a API inverteu os times, nós invertemos a ordem dos gols para não punir o usuário!
                        placarReal1 = j.score.fullTime.away;
                        placarReal2 = j.score.fullTime.home;
                        return true;
                    }
                    return false;
                });

                if (jogoOficial && !palpite.pontuado) {
                    const palpite1 = palpite.placar_1;
                    const palpite2 = palpite.placar_2;

                    let pontosGanhos = 0;

                    // Lógica de pontos: 5 pra mosca, 2 pro vencedor
                    if (palpite1 === placarReal1 && palpite2 === placarReal2) {
                        pontosGanhos = 5; 
                    } else {
                        const vencedorReal = placarReal1 > placarReal2 ? 1 : (placarReal1 < placarReal2 ? 2 : 0);
                        const vencedorPalpite = palpite1 > palpite2 ? 1 : (palpite1 < palpite2 ? 2 : 0);
                        if (vencedorReal === vencedorPalpite) pontosGanhos = 2; 
                    }

                    if (pontosGanhos > 0) {
                        palpite.pontos_obtidos = pontosGanhos;
                        palpite.pontuado = true;
                        houveMudanca = true;
                    }
                }
                
                pontosTotal += (palpite.pontos_obtidos || 0);
            });

            if (houveMudanca) {
                doc.pontos_acumulados = pontosTotal;
                await cloudant.putDocument({ db: DB_NAME, docId: doc._id, document: doc });
            }
        }
        console.log('✅ Pontuações sincronizadas com sucesso!');
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
      let palpitesAtuais = existingDoc.palpites_jogos || [];

      palpites.forEach(novoPalpite => {
        const index = palpitesAtuais.findIndex(p => p.time_1 === novoPalpite.time_1 && p.time_2 === novoPalpite.time_2);
        if (index >= 0) {
            // Só permite sobrescrever o palpite se ele AINDA NÃO FOI pontuado pelo Cron Job
            if (!palpitesAtuais[index].pontuado) {
                palpitesAtuais[index] = novoPalpite;
            }
        } else {
          palpitesAtuais.push(novoPalpite);
        }
      });

      existingDoc.palpites_jogos = palpitesAtuais;
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
