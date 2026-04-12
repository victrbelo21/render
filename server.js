const express = require('express');
const cors = require('cors');
const { CloudantV1 } = require('@ibm-cloud/cloudant');
const { IamAuthenticator } = require('ibm-cloud-sdk-core');

const app = express();
app.use(cors()); // Permite que o seu frontend converse com este backend
app.use(express.json());

// 1. Autenticação Segura puxando as variáveis de ambiente do painel da IBM
const authenticator = new IamAuthenticator({
  apikey: process.env.CLOUDANT_APIKEY
});

const cloudant = new CloudantV1({
  authenticator: authenticator
});
cloudant.setServiceUrl(process.env.CLOUDANT_URL);

// 2. Criar a Rota (O endereço que o frontend vai chamar)
app.post('/salvar-palpite', async (req, res) => {
  try {
    const palpiteData = req.body;

    // Documento JSON que será salvo no Cloudant
    const documento = {
      type: "palpite",
      ...palpiteData,
      timestamp: new Date().toISOString()
    };

    const response = await cloudant.postDocument({
      db: 'palpites_2026', // O nome do banco que você criou no Passo 2
      document: documento
    });

    res.status(200).json({ success: true, id: response.result.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'Erro ao salvar no banco' });
  }
});

// 3. Ligar o servidor na porta que a IBM Cloud definir
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});