const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // Certifique-se de ter rodado: npm install node-fetch@2
const { CloudantV1 } = require('@ibm-cloud/cloudant');
const { IamAuthenticator } = require('ibm-cloud-sdk-core');

const app = express();

// Configuração do CORS e JSON
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
// 2. ROTA DE NOTÍCIAS (Proxy para burlar o CORS da NewsAPI)
// =====================================================================
app.get('/noticias', async (req, res) => {
    // Sua chave da NewsAPI
    const API_KEY = '99f3722bea4049eea78883baeada90cd';
    
    // Filtro para garantir apenas Copa do Mundo 2026 e Futebol (evita ginástica e outros)
    const query = encodeURIComponent('"Copa do Mundo FIFA 2026" OR ("Copa do Mundo 2026" AND futebol)');
    
    // Buscamos as 5 notícias mais recentes
    const url = `https://newsapi.org/v2/everything?q=${query}&language=pt&sortBy=publishedAt&pageSize=5&apiKey=${API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        
        // Retorna os dados da NewsAPI direto para o seu frontend
        res.json(data);
    } catch (error) {
        console.error("Erro na ponte de notícias:", error);
        res.status(500).json({ status: "error", message: "Falha ao buscar notícias no servidor" });
    }
});

// =====================================================================
// 3. ROTAS DO BOLÃO (Cloudant)
// =====================================================================

// ROTA A: Salvar Palpites em Lote
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

      res.status(200).json({ success: true, message: "Cartela atualizada com sucesso" });
    } else {
      const novoDocumento = {
        type: "cartela_usuario",
        user_email: user_email,
        user_name: user_name,
        palpites_jogos: palpites,
        palpite_final: null,
        timestamp: new Date().toISOString()
      };

      await cloudant.postDocument({
        db: DB_NAME,
        document: novoDocumento
      });

      res.status(200).json({ success: true, message: "Cartela criada com sucesso" });
    }

  } catch (error) {
    console.error("Erro na rota /salvar-lote:", error);
    res.status(500).json({ success: false, error: 'Erro ao processar lote no servidor' });
  }
});

// ROTA B: Salvar Palpite da Final
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

      await cloudant.putDocument({
        db: DB_NAME,
        docId: existingDoc._id,
        document: existingDoc
      });
      res.status(200).json({ success: true, message: "Final adicionada à cartela" });
    } else {
      const novoDocumento = {
        type: "cartela_usuario",
        user_email: user_email,
        user_name: user_name || user_email.split('@')[0],
        palpites_jogos: [],
        palpite_final: dadosDaFinal,
        timestamp: new Date().toISOString()
      };

      await cloudant.postDocument({
        db: DB_NAME,
        document: novoDocumento
      });
      res.status(200).json({ success: true, message: "Cartela criada via final" });
    }

  } catch (error) {
    console.error("Erro na rota /salvar-final:", error);
    res.status(500).json({ success: false, error: 'Erro ao processar palpite final' });
  }
});

// ROTA C: Buscar o Ranking Geral
app.get('/ranking', async (req, res) => {
  try {
    const response = await cloudant.postFind({
      db: DB_NAME,
      selector: {
        type: { "$eq": "cartela_usuario" }
      },
      limit: 2000
    });

    const cartelas = response.result.docs;

    const rankingArray = cartelas.map(cartela => {
      return {
        email: cartela.user_email,
        nome: cartela.user_name,
        pontos: 0,
        totalPalpites: cartela.palpites_jogos ? cartela.palpites_jogos.length : 0
      };
    });

    rankingArray.sort((a, b) => {
      if (b.pontos !== a.pontos) return b.pontos - a.pontos;
      return b.totalPalpites - a.totalPalpites;
    });

    res.status(200).json({ success: true, ranking: rankingArray });

  } catch (error) {
    console.error("Erro na rota /ranking:", error);
    res.status(500).json({ success: false, error: 'Erro ao gerar o ranking' });
  }
});

// =====================================================================
// 4. INICIALIZAÇÃO DO SERVIDOR
// =====================================================================
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Servidor do Bolão 2026 (Backend + Proxy News) rodando na porta ${port}`);
});
