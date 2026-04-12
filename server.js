const express = require('express');
const cors = require('cors');
const { CloudantV1 } = require('@ibm-cloud/cloudant');
const { IamAuthenticator } = require('ibm-cloud-sdk-core');

const app = express();

// Configuração do CORS para permitir que a interface comunique com a API
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
// 2. ROTAS DA API
// =====================================================================

// ROTA A: Salvar ou ATUALIZAR Palpites dos Jogos (Upsert)
app.post('/salvar-palpite', async (req, res) => {
  try {
    const { user_email, user_name, grupo, data_jogo, horario, time_1, placar_1, time_2, placar_2 } = req.body;

    // 1. Busca se já existe um palpite deste usuário para este jogo
    const searchResponse = await cloudant.postFind({
      db: DB_NAME,
      selector: {
        type: { "$eq": "palpite" },
        user_email: { "$eq": user_email },
        time_1: { "$eq": time_1 },
        time_2: { "$eq": time_2 }
      }
    });

    const existingDoc = searchResponse.result.docs[0];

    // 2. Monta o documento com os dados recebidos
    const documento = {
      type: "palpite",
      user_email,
      user_name,
      grupo,
      data_jogo,
      horario,
      time_1,
      placar_1,
      time_2,
      placar_2,
      timestamp: new Date().toISOString()
    };

    if (existingDoc) {
      // 3. Atualiza o documento existente (preserva o ID e a Revisão)
      documento._id = existingDoc._id;
      documento._rev = existingDoc._rev;

      await cloudant.putDocument({
        db: DB_NAME,
        docId: existingDoc._id,
        document: documento
      });
      
      res.status(200).json({ success: true, message: "Palpite atualizado", id: existingDoc._id });
    } else {
      // 4. Cria um documento novo
      const response = await cloudant.postDocument({
        db: DB_NAME,
        document: documento
      });
      
      res.status(200).json({ success: true, message: "Palpite criado", id: response.result.id });
    }

  } catch (error) {
    console.error("Erro na rota /salvar-palpite:", error);
    res.status(500).json({ success: false, error: 'Erro ao processar palpite no servidor' });
  }
});


// ROTA B: Salvar ou ATUALIZAR Palpite da Final (Upsert)
app.post('/salvar-final', async (req, res) => {
  try {
    const { user_email, vencedor_campeonato, placar_final } = req.body;

    // 1. Busca se o usuário já tem um palpite final registrado
    const searchResponse = await cloudant.postFind({
      db: DB_NAME,
      selector: {
        type: { "$eq": "palpite_final" },
        user_email: { "$eq": user_email }
      }
    });

    const existingDoc = searchResponse.result.docs[0];

    const documento = {
      type: "palpite_final",
      user_email,
      vencedor_campeonato,
      placar_final,
      timestamp: new Date().toISOString()
    };

    if (existingDoc) {
      // 2. Atualiza o palpite final
      documento._id = existingDoc._id;
      documento._rev = existingDoc._rev;

      await cloudant.putDocument({
        db: DB_NAME,
        docId: existingDoc._id,
        document: documento
      });
      res.status(200).json({ success: true, message: "Palpite final atualizado", id: existingDoc._id });
    } else {
      // 3. Cria o palpite final pela primeira vez
      const response = await cloudant.postDocument({
        db: DB_NAME,
        document: documento
      });
      res.status(200).json({ success: true, message: "Palpite final criado", id: response.result.id });
    }

  } catch (error) {
    console.error("Erro na rota /salvar-final:", error);
    res.status(500).json({ success: false, error: 'Erro ao processar palpite final no servidor' });
  }
});


// ROTA C: Buscar o Ranking Geral
app.get('/ranking', async (req, res) => {
  try {
    const response = await cloudant.postFind({
      db: DB_NAME,
      selector: {
        type: { "$eq": "palpite" }
      },
      limit: 2000
    });

    const todosPalpites = response.result.docs;
    const usuarios = {};

    todosPalpites.forEach(palpite => {
      const email = palpite.user_email || 'anonimo@bolao.com';
      const nomeReal = palpite.user_name || email.split('@')[0].replace('.', ' ');
      
      if (!usuarios[email]) {
        usuarios[email] = {
          email: email,
          nome: nomeReal, 
          pontos: 0, 
          totalPalpites: 0
        };
      }
      
      usuarios[email].totalPalpites += 1;
    });

    const rankingArray = Object.values(usuarios).sort((a, b) => {
      if (b.pontos !== a.pontos) {
        return b.pontos - a.pontos;
      }
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
