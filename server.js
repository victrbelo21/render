const express = require('express');
const cors = require('cors');
const { CloudantV1 } = require('@ibm-cloud/cloudant');
const { IamAuthenticator } = require('ibm-cloud-sdk-core');

const app = express();

// Configuração do CORS
app.use(cors());
app.use(express.json());

// =====================================================================
// 1. AUTENTICAÇÃO COM A IBM CLOUD
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
// 2. ROTAS DA API (Arquitetura de Documento Único por Usuário)
// =====================================================================

// ROTA A: Salvar Palpites em Lote (Gera/Atualiza apenas 1 documento por pessoa)
app.post('/salvar-lote', async (req, res) => {
  try {
    const { user_email, user_name, palpites } = req.body;

    // 1. Busca a cartela única deste usuário
    const searchResponse = await cloudant.postFind({
      db: DB_NAME,
      selector: {
        type: { "$eq": "cartela_usuario" },
        user_email: { "$eq": user_email }
      }
    });

    const existingDoc = searchResponse.result.docs[0];

    if (existingDoc) {
      // 2. Se a cartela existe, fazemos um MERGE inteligente
      // Preservamos palpites antigos e atualizamos/adicionamos os novos
      let palpitesAtuais = existingDoc.palpites_jogos || [];

      palpites.forEach(novoPalpite => {
        // Tenta achar se esse jogo já estava na cartela
        const index = palpitesAtuais.findIndex(p => p.time_1 === novoPalpite.time_1 && p.time_2 === novoPalpite.time_2);
        
        if (index >= 0) {
          palpitesAtuais[index] = novoPalpite; // Atualiza o placar se o jogo já existia
        } else {
          palpitesAtuais.push(novoPalpite); // Adiciona na cartela se for um jogo novo
        }
      });

      existingDoc.palpites_jogos = palpitesAtuais;
      existingDoc.user_name = user_name; // Garante que o nome visual está atualizado
      existingDoc.timestamp = new Date().toISOString();

      await cloudant.putDocument({
        db: DB_NAME,
        docId: existingDoc._id,
        document: existingDoc
      });

      res.status(200).json({ success: true, message: "Cartela atualizada com sucesso" });
    } else {
      // 3. Se não existe, cria a primeira cartela da pessoa
      const novoDocumento = {
        type: "cartela_usuario",
        user_email: user_email,
        user_name: user_name,
        palpites_jogos: palpites,
        palpite_final: null, // Fica vazio até a pessoa preencher na index
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


// ROTA B: Salvar Palpite da Final (Atualiza a mesma cartela única)
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
      // Atualiza apenas a seção da final na cartela
      existingDoc.palpite_final = dadosDaFinal;
      existingDoc.timestamp = new Date().toISOString();

      await cloudant.putDocument({
        db: DB_NAME,
        docId: existingDoc._id,
        document: existingDoc
      });
      res.status(200).json({ success: true, message: "Final adicionada à cartela" });
    } else {
      // Se ele deu o palpite final antes mesmo de palpitar nos jogos base
      const novoDocumento = {
        type: "cartela_usuario",
        user_email: user_email,
        user_name: user_name || user_email.split('@')[0],
        palpites_jogos: [], // Arrays de jogos vazia por enquanto
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


// ROTA C: Buscar o Ranking Geral (Lendo as Cartelas Únicas)
app.get('/ranking', async (req, res) => {
  try {
    const response = await cloudant.postFind({
      db: DB_NAME,
      selector: {
        type: { "$eq": "cartela_usuario" } // Procura apenas pelas cartelas mestres
      },
      limit: 2000
    });

    const cartelas = response.result.docs;

    // Transforma as cartelas na lista de pontuação
    const rankingArray = cartelas.map(cartela => {
      return {
        email: cartela.user_email,
        nome: cartela.user_name,
        pontos: 0, // Regra a ser implementada na Copa
        totalPalpites: cartela.palpites_jogos ? cartela.palpites_jogos.length : 0
      };
    });

    // Ordena: Pontos primeiro, depois quem deu mais palpites
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
// 3. INICIALIZAÇÃO DO SERVIDOR
// =====================================================================
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Servidor do Bolão 2026 rodando na porta ${port}`);
});
