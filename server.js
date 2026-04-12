const express = require('express');
const cors = require('cors');
const { CloudantV1 } = require('@ibm-cloud/cloudant');
const { IamAuthenticator } = require('ibm-cloud-sdk-core');

const app = express();

// Configuração do CORS para permitir que o seu site converse com essa API
app.use(cors());
app.use(express.json());

// =====================================================================
// 1. AUTENTICAÇÃO COM A IBM CLOUD (O Cofre)
// =====================================================================
// Essas variáveis são puxadas automaticamente do painel do Render
const authenticator = new IamAuthenticator({
  apikey: process.env.CLOUDANT_APIKEY
});

const cloudant = new CloudantV1({
  authenticator: authenticator
});

// Define o endereço do seu banco de dados
cloudant.setServiceUrl(process.env.CLOUDANT_URL);

// Nome fixo do banco que você criou no painel do Cloudant
const DB_NAME = 'palpites_2026';

// =====================================================================
// 2. ROTAS DA API (Os caminhos que o seu Frontend vai chamar)
// =====================================================================

// ROTA A: Salvar Palpites dos Jogos Individuais (Vem da página 'palpites.html')
app.post('/salvar-palpite', async (req, res) => {
  try {
    const palpiteData = req.body;

    const documento = {
      type: "palpite",
      ...palpiteData,
      timestamp: new Date().toISOString()
    };

    const response = await cloudant.postDocument({
      db: DB_NAME,
      document: documento
    });

    res.status(200).json({ success: true, id: response.result.id });
  } catch (error) {
    console.error("Erro na rota /salvar-palpite:", error);
    res.status(500).json({ success: false, error: 'Erro ao salvar no banco' });
  }
});


// ROTA B: Salvar Palpite do Vencedor Final (Vem da página 'index.html')
app.post('/salvar-final', async (req, res) => {
  try {
    const palpiteData = req.body;

    const documento = {
      type: "palpite_final",
      ...palpiteData,
      timestamp: new Date().toISOString()
    };

    const response = await cloudant.postDocument({
      db: DB_NAME,
      document: documento
    });

    res.status(200).json({ success: true, id: response.result.id });
  } catch (error) {
    console.error("Erro na rota /salvar-final:", error);
    res.status(500).json({ success: false, error: 'Erro ao salvar final no banco' });
  }
});


// ROTA C: Buscar o Ranking Geral (Vem da página 'ranking.html')
app.get('/ranking', async (req, res) => {
  try {
    // 1. Pede ao Cloudant todos os documentos marcados como "palpite"
    const response = await cloudant.postFind({
      db: DB_NAME,
      selector: {
        type: { "$eq": "palpite" }
      },
      limit: 2000 // Limite de documentos a procurar. Aumente se o bolão crescer muito.
    });

    const todosPalpites = response.result.docs;

    // 2. Agrupa a contagem por usuário (Email)
    const usuarios = {};

    todosPalpites.forEach(palpite => {
      const email = palpite.user_email || 'anonimo@bolao.com';
      
      // Pega o nome completo que vem do frontend, ou faz o fallback pro começo do email se for um palpite antigo de teste
      const nomeReal = palpite.user_name || email.split('@')[0].replace('.', ' ');
      
      if (!usuarios[email]) {
        // Se é a primeira vez que vemos este email, criamos o perfil dele
        usuarios[email] = {
          email: email,
          nome: nomeReal, 
          pontos: 0, // A ser atualizado quando os jogos reais acontecerem
          totalPalpites: 0
        };
      }
      
      // Adiciona +1 à contagem de palpites registrados por essa pessoa
      usuarios[email].totalPalpites += 1;
    });

    // 3. Transforma o objeto num Array e ordena
    // Regra atual: Quem tem mais pontos fica no topo. Desempate: quem deu mais palpites.
    const rankingArray = Object.values(usuarios).sort((a, b) => {
      if (b.pontos !== a.pontos) {
        return b.pontos - a.pontos;
      }
      return b.totalPalpites - a.totalPalpites;
    });

    // Devolve a lista formatada para o HTML desenhar a tabela
    res.status(200).json({ success: true, ranking: rankingArray });

  } catch (error) {
    console.error("Erro na rota /ranking:", error);
    res.status(500).json({ success: false, error: 'Erro ao gerar o ranking' });
  }
});

// =====================================================================
// 3. INICIALIZAÇÃO DO SERVIDOR
// =====================================================================
// O Render define a porta automaticamente através da variável process.env.PORT
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Servidor do Bolão 2026 rodando na porta ${port}`);
});
