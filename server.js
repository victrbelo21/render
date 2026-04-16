const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // Requer: npm install node-fetch@2
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
// 2. ROTA DE NOTÍCIAS (Proxy Seguro NewsAPI com Filtros)
// =====================================================================
app.get('/noticias', async (req, res) => {
    const API_KEY = '99f3722bea4049eea78883baeada90cd';
    
    // 1. Bloqueamos as palavras direto na fonte usando o sinal de menos (-)
    // Adicionei "aposta" e "apostas" por garantia, já que o alvo são as bets!
    const query = encodeURIComponent('"Copa do Mundo FIFA 2026" -ig.com.br -bets -bet -bayern -aposta -apostas -1958 -1962 -1994 -1998 -2002 -2006 -2010 -2014 -2018 -2022');
    
    // 2. Pedimos 15 notícias em vez de 5, para ter "gordura" para filtrar as nulas
    const url = `https://newsapi.org/v2/everything?q=${query}&language=pt&sortBy=publishedAt&pageSize=15&apiKey=${API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        // 3. Se a API retornou os dados com sucesso, fazemos a faxina dos nulos
        if (data.status === 'ok' && data.articles) {
            
            const artigosValidos = data.articles.filter(article => {
                // Mantém apenas os artigos que tem Título, Imagem, Descrição e que não foram removidos pela fonte
                return article.title && 
                       article.title !== '[Removed]' && 
                       article.urlToImage && 
                       article.description;
            });

            // 4. Cortamos apenas os 5 primeiros artigos válidos para devolver ao Front-end
            data.articles = artigosValidos.slice(0, 5);
        }

        res.json(data);
    } catch (error) {
        console.error("Erro na ponte de notícias:", error);
        res.status(500).json({ status: "error", message: "Falha ao buscar notícias" });
    }
});

// =====================================================================
// 3. ROTAS DO BOLÃO (Apostas, Cartelas e Ranking)
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

      // Mescla os palpites novos com os antigos
      palpites.forEach(novoPalpite => {
        const index = palpitesAtuais.findIndex(p => p.time_1 === novoPalpite.time_1 && p.time_2 === novoPalpite.time_2);
        if (index >= 0) {
          palpitesAtuais[index] = novoPalpite;
        } else {
          palpitesAtuais.push(novoPalpite);
        }
      });

      existingDoc.palpites_jogos = palpitesAtuais;
      existingDoc.user_name = user_name;
      existingDoc.timestamp = new Date().toISOString();

      await cloudant.putDocument({
        db: DB_NAME,
        docId: existingDoc._id,
        document: existingDoc
      });
      res.status(200).json({ success: true, message: "Cartela atualizada" });
    } else {
      const novoDocumento = {
        type: "cartela_usuario",
        user_email, user_name, 
        palpites_jogos: palpites,
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
      selector: {
        type: { "$eq": "cartela_usuario" },
        user_email: { "$eq": user_email }
      }
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

    const cartelas = response.result.docs;
    const rankingArray = cartelas.map(cartela => ({
        email: cartela.user_email,
        nome: cartela.user_name,
        pontos: 0, // A lógica matemática de acertos entra aqui depois
        totalPalpites: cartela.palpites_jogos ? cartela.palpites_jogos.length : 0
    }));

    // Ordena: Maior ponto primeiro, desempate por mais palpites feitos
    rankingArray.sort((a, b) => {
      if (b.pontos !== a.pontos) return b.pontos - a.pontos;
      return b.totalPalpites - a.totalPalpites;
    });

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
// 4. ROTAS DO FEED SOCIAL (Mural da Resenha, Likes, Replies e Delete)
// =====================================================================

// Postar mensagem principal
app.post('/chat', async (req, res) => {
    try {
        const { user_email, user_name, mensagem } = req.body;
        const novoDocumento = {
            type: "chat_message",
            user_email, user_name, mensagem,
            timestamp: new Date().toISOString(),
            likes: [],   // Array para e-mails de quem curtiu
            replies: []  // Array para os sub-comentários
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
            limit: 100 // Puxa as 100 mais recentes
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
        
        if (index > -1) {
            doc.likes.splice(index, 1); // Remove
        } else {
            doc.likes.push(user_email); // Adiciona
        }

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
        
        // Injeta a resposta gerando um ID pseudo-randômico único para ela
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
            
            if (index > -1) {
                reply.likes.splice(index, 1); // Remove
            } else {
                reply.likes.push(user_email); // Adiciona
            }
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

        // Validação de segurança: só o dono do post pode apagar
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
// 5. INICIALIZAÇÃO DO SERVIDOR
// =====================================================================
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Servidor Node.js (Bolão + Proxy + Chat) rodando na porta ${port}`);
});
