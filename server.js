const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); 
const cron = require('node-cron');
const cheerio = require('cheerio');
const { CloudantV1 } = require('@ibm-cloud/cloudant');
const { IamAuthenticator } = require('ibm-cloud-sdk-core');

const app = express();

// Configuração de segurança e parse
app.use(cors({
    origin: ['https://pages.github.ibm.com']
}));
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
// CACHE DO RANKING
// =====================================================================
let rankingCache = null;
let ultimaAtualizacaoCache = 0;
const TEMPO_CACHE_MINUTOS = 5;
const ID_CONTROLE_JOGOS = 'controle_processamento_jogos';

// =====================================================================
// CACHE DE NOTÍCIAS (1x por dia)
// =====================================================================
let noticiasCache = null;
let ultimaDataNoticias = ""; // Armazena a data no formato "YYYY-MM-DD"

// =====================================================================
// Configuração API Football-Data.org
// =====================================================================
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;

// Dicionário Oficial - Copa do Mundo 2026 (Sem acentos do lado esquerdo)
const dicionarioTimes = {
    "africa do sul": "south africa",
    "alemanha": "germany",
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
    "costa do marfim": "cote divoire", // football-data usa "Côte d'Ivoire", nossa função limpa para "cote divoire"
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
    
    // 3. Se já vier como ISO padrão da API
    if (dataString.length >= 10) {
        return dataString.substring(0, 10);
    }
    
    return dataString;
}

// =====================================================================
// 2. O TRABALHADOR INVISÍVEL (CRON JOB) - Recálculo Contínuo
// =====================================================================
cron.schedule('*/10 * * * *', async () => {
    console.log('⚽ Verificando novos resultados da Copa...');
    
    try {
        // 1. Busca o documento de controle no Cloudant
        let controleDoc;
        try {
            controleDoc = (await cloudant.getDocument({ db: DB_NAME, docId: ID_CONTROLE_JOGOS })).result;
        } catch (e) {
            // Se o documento não existir ainda, ele cria um novo para começar o histórico
            controleDoc = { _id: ID_CONTROLE_JOGOS, jogos_processados: [], type: "config" };
            await cloudant.postDocument({ db: DB_NAME, document: controleDoc });
        }

        // 2. Busca jogos finalizados na API
        const response = await fetch(`https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED`, {
            headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN }
        });
        
        const data = await response.json();
        
        if (data.errorCode) {
            console.log('❌ Erro na API:', data.message);
            return;
        }
        
        const jogosDaAPI = data.matches || [];
        
        // Filtra apenas os jogos que a API diz que acabaram mas que NÃO estão na nossa lista do Cloudant
        const jogosOficiais = jogosDaAPI.filter(jogo => !controleDoc.jogos_processados.includes(jogo.id));

        if (jogosOficiais.length === 0) {
            console.log('✅ Tudo atualizado. Nenhum jogo novo para pontuar.');
            return;
        }

        console.log(`🎯 Encontrados ${jogosOficiais.length} novos jogos para processar!`);
        
        const userDocs = await cloudant.postFind({
            db: DB_NAME,
            selector: { type: { "$eq": "cartela_usuario" } },
            limit: 2000
        });

        const cartelas = userDocs.result.docs;
        const documentosParaAtualizar = [];

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

                    // Trava de Data
                    const bateuData = dataPalpite ? (dataPalpite === dataAPI) : true;

                    // Lógica Bi-direcional (Permite inverter Casa/Fora)
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
                documentosParaAtualizar.push(doc);
            }
        }

        // =====================================================================
        // O ENVIO EM MASSA (Bulk Docs) E ATUALIZAÇÃO DO CONTROLE
        // =====================================================================
        if (documentosParaAtualizar.length > 0) {
            // Adiciona os IDs dos jogos novos na lista de processados
            jogosOficiais.forEach(jogo => controleDoc.jogos_processados.push(jogo.id));
            
            // Coloca o documento de controle dentro da mesma caixa de envio das cartelas
            documentosParaAtualizar.push(controleDoc);

            // Bate na porta do Cloudant UMA única vez com tudo
            await cloudant.postBulkDocs({
                db: DB_NAME,
                bulkDocs: { docs: documentosParaAtualizar }
            });
            console.log(`📦 Atualização em massa concluída! ${documentosParaAtualizar.length} documentos salvos (incluindo controle).`);
            
        } else if (jogosOficiais.length > 0) {
            // Se jogos terminaram, mas nenhum usuário pontuou ou teve mudança na cartela
            jogosOficiais.forEach(jogo => controleDoc.jogos_processados.push(jogo.id));
            await cloudant.putDocument({ db: DB_NAME, docId: controleDoc._id, document: controleDoc });
            console.log('✅ Jogos registrados no controle, mas nenhuma cartela precisou de atualização.');
        }
        
    } catch (error) {
        console.error('❌ Erro no Cron Job:', error);
    }
});

// =====================================================================
// 3. ROTA DE NOTÍCIAS (Web Scraping Direto - FIFA Oficial)
// =====================================================================
app.get('/noticias', async (req, res) => {
    console.log("🌐 Raspando notícias em tempo real direto da FIFA...");
    
    try {
        const fifaUrl = 'https://www.fifa.com/pt/cat/1aQDyhkYnKhkAW347zYi4Y';
        
        // Fazemos a requisição disfarçados de navegador comum para a FIFA não bloquear
        const response = await fetch(fifaUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const html = await response.text();
        const $ = cheerio.load(html); // Carrega o HTML na engine do Cheerio
        
        const artigos = [];

        // O Cheerio vai varrer todas as tags <a> (links) da página
        $('a').each((i, element) => {
            const link = $(element).attr('href');
            
            // Só nos interessam links que pareçam ser de conteúdo (news, tournaments, etc)
            if (link && (link.includes('/news/') || link.includes('/tournaments/'))) {
                
                // A FIFA costuma usar links relativos, então garantimos o domínio absoluto
                const baseUrl = link.startsWith('http') ? '' : 'https://www.fifa.com';
                const fullUrl = baseUrl + link;
                
                // Caça o texto que estiver dentro de um header ou parágrafo dentro desse link
                const titulo = $(element).find('h2, h3, h4').first().text().trim() || 
                               $(element).find('p').first().text().trim();
                
                // Caça a imagem (pode estar numa tag <source> do <picture> ou num <img> padrão)
                let imgUrl = $(element).find('picture source').attr('srcset') || 
                             $(element).find('img').attr('src') || '';
                
                // Se a imagem vier em formato srcset (ex: "img1.jpg 1x, img2.jpg 2x"), pegamos só o primeiro link
                if (imgUrl && imgUrl.includes(' ')) {
                    imgUrl = imgUrl.split(' ')[0];
                }

                // Só colocamos no nosso JSON final se achamos Título, Imagem e se já não adicionamos antes
                if (titulo && imgUrl && !artigos.find(a => a.title === titulo)) {
                    artigos.push({
                        title: titulo,
                        url: fullUrl,
                        urlToImage: imgUrl,
                        source: { name: 'FIFA.com' },
                        publishedAt: new Date().toISOString() // Data dummy, o frontend formata sozinho
                    });
                }
            }
        });

        console.log(`✅ Scraping concluído. Foram achadas ${artigos.length} matérias da Copa.`);

        // Entregamos pro seu front-end exatamente o que ele espera, e só os 5 primeiros cards
        res.json({
            status: 'ok',
            articles: artigos.slice(0, 5)
        });

    } catch (error) {
        console.error("❌ Erro no scraping da FIFA:", error);
        res.status(500).json({ status: "error", message: "Falha ao raspar site da FIFA" });
    }
});

// =====================================================================
// 4. ROTAS DO BOLÃO (Apostas, Cartelas e Ranking)
// =====================================================================

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

app.get('/ranking', async (req, res) => {
  try {
    // 1. Verifica se o cache existe e se ainda está no prazo de validade
    const agora = Date.now();
    const tempoPassado = (agora - ultimaAtualizacaoCache) / 1000 / 60;
    
    if (rankingCache && tempoPassado < TEMPO_CACHE_MINUTOS) {
        console.log("⚡ Servindo ranking direto do cache da memória!");
        return res.status(200).json({ success: true, ranking: rankingCache });
    }

    console.log("🐌 Buscando ranking direto no Cloudant...");
    const response = await cloudant.postFind({
      db: DB_NAME,
      selector: { type: { "$eq": "cartela_usuario" } },
      limit: 2000
    });

    const rankingArray = response.result.docs.map(doc => ({
        email: doc.user_email,
        nome: doc.user_name,
        pontos: doc.pontos_acumulados || 0,
        totalPalpites: doc.palpites_jogos ? doc.palpites_jogos.length : 0,
        time_coracao: doc.time_coracao || '', 
        recorde_embaixadinha: doc.recorde_embaixadinha || 0 
    }));

    rankingArray.sort((a, b) => b.pontos - a.pontos || b.totalPalpites - a.totalPalpites);
    
    // 2. Guarda o resultado fresco no cache e zera o cronômetro
    rankingCache = rankingArray;
    ultimaAtualizacaoCache = Date.now();

    res.status(200).json({ success: true, ranking: rankingArray });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Erro ao gerar ranking' });
  }
});

app.post('/buscar-cartela', async (req, res) => {
  try {
    const { user_email } = req.body;
    const searchResponse = await cloudant.postFind({
      db: DB_NAME,
      selector: { type: { "$eq": "cartela_usuario" }, user_email: { "$eq": user_email } }
    });

    const existingDoc = searchResponse.result.docs[0];
    res.status(200).json({ success: true, palpites: existingDoc ? (existingDoc.palpites_jogos || []) : [], album: existingDoc ? existingDoc.album : null });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Erro ao buscar cartela' });
  }
});

// =====================================================================
// ROTAS DO PERFIL (Salvar Time do Coração e Embaixadinhas)
// =====================================================================
app.post('/atualizar-perfil', async (req, res) => {
  try {
    const { user_email, time_coracao, recorde_embaixadinha } = req.body;
    
    const searchResponse = await cloudant.postFind({
      db: DB_NAME,
      selector: { type: { "$eq": "cartela_usuario" }, user_email: { "$eq": user_email } }
    });

    const existingDoc = searchResponse.result.docs[0];

    if (existingDoc) {
      // Atualiza apenas se o dado foi enviado pelo site
      if (time_coracao !== undefined && time_coracao !== "") {
          existingDoc.time_coracao = time_coracao;
      }
      if (recorde_embaixadinha !== undefined) {
          // Só atualiza se o recorde novo for maior que o antigo salvo no banco
          if (!existingDoc.recorde_embaixadinha || recorde_embaixadinha > existingDoc.recorde_embaixadinha) {
              existingDoc.recorde_embaixadinha = recorde_embaixadinha;
          }
      }
      
      await cloudant.putDocument({ db: DB_NAME, docId: existingDoc._id, document: existingDoc });
      res.status(200).json({ success: true, message: "Perfil atualizado!" });
    } else {
      res.status(404).json({ success: false, error: 'Usuário não encontrado. Crie um palpite primeiro.' });
    }
  } catch (error) {
    console.error("Erro ao atualizar perfil:", error);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// =====================================================================
// ROTA DO ÁLBUM (Abrir Pacotinho Diário)
// =====================================================================
app.post('/abrir-pacote', async (req, res) => {
    try {
        const { user_email } = req.body;
        
        const searchResponse = await cloudant.postFind({
            db: DB_NAME,
            selector: { type: { "$eq": "cartela_usuario" }, user_email: { "$eq": user_email } }
        });

        const userDoc = searchResponse.result.docs[0];
        if (!userDoc) return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });

        // 1. Inicializa o álbum se o usuário ainda não tiver
        if (!userDoc.album) {
            userDoc.album = { coladas: [], repetidas: [], ultimo_pacotinho: null };
        }

        // 2. Trava de Segurança (Virada ao MEIO-DIA de São Paulo)
        // Pega a hora exata em SP e cria um objeto Date
        const stringSP = new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
        const dataSP = new Date(stringSP);
        
        // Subtrai 12 horas da conta. 
        // Se for 11h da manhã do dia 15, o código enxerga como 23h do dia 14.
        dataSP.setHours(dataSP.getHours() - 12);
        
        // Monta a string do ciclo (Ex: "2026-06-15")
        const ano = dataSP.getFullYear();
        const mes = String(dataSP.getMonth() + 1).padStart(2, '0');
        const dia = String(dataSP.getDate()).padStart(2, '0');
        const cicloAtual = `${ano}-${mes}-${dia}`;
        
        if (userDoc.album.ultimo_pacotinho === cicloAtual) {
            return res.status(400).json({ success: false, error: 'O carteiro só passa ao meio-dia. Volte mais tarde!' });
        }

        // 3. Motor de Probabilidade (Raridade)
        const figurinhasSorteadas = [];
        const QTD_POR_PACOTE = 5;

        for (let i = 0; i < QTD_POR_PACOTE; i++) {
            const chance = Math.random() * 100; // Sorteia um número de 0 a 100
            let figurinhaSorteada;

            if (chance < 5) {
                // 5% de chance: Figurinhas Lendárias (IDs 81 a 86)
                figurinhaSorteada = Math.floor(Math.random() * (86 - 81 + 1)) + 81;
            } else if (chance < 25) {
                // 20% de chance: Figurinhas Raras (IDs 61 a 80)
                figurinhaSorteada = Math.floor(Math.random() * (80 - 61 + 1)) + 61;
            } else {
                // 75% de chance: Figurinhas Comuns (IDs 1 a 60)
                figurinhaSorteada = Math.floor(Math.random() * (60 - 1 + 1)) + 1;
            }
            figurinhasSorteadas.push(figurinhaSorteada);
        }

        // 4. Separa o que é nova (vai colar) do que é repetida
        const novasParaColar = [];
        const novasRepetidas = [];

        figurinhasSorteadas.forEach(fig => {
            // Verifica se a figurinha já está colada no banco OU se foi sorteada repetida dentro deste mesmo pacotinho
            if (userDoc.album.coladas.includes(fig) || novasParaColar.includes(fig)) {
                novasRepetidas.push(fig);
                userDoc.album.repetidas.push(fig);
            } else {
                novasParaColar.push(fig);
                userDoc.album.coladas.push(fig);
            }
        });

        // 5. Salva no banco e atualiza a data de hoje
        userDoc.album.ultimo_pacotinho = cicloAtual;
        await cloudant.putDocument({ db: DB_NAME, docId: userDoc._id, document: userDoc });

        // Devolve pro site as listas separadas para fazermos as animações visuais
        res.status(200).json({ 
            success: true, 
            sorteadas: figurinhasSorteadas,
            novas: novasParaColar,
            repetidas: novasRepetidas 
        });

    } catch (error) {
        console.error("Erro ao abrir pacote:", error);
        res.status(500).json({ success: false, error: 'Erro ao gerar figurinhas.' });
    }
});

// =====================================================================
// ROTA DO AGENTE DE IA NATIVO (Bolão Agentic - JSON-RPC 2.0)
// =====================================================================
app.post('/agente-bolao', async (req, res) => {
    const { mensagem, historico } = req.body;
    
    if (!mensagem) return res.status(400).json({ error: "Mensagem vazia." });

    try {
        const agenteEndpoint = process.env.ICA_AGENT_URL; 
        
        // --- FORMATAÇÃO PROFISSIONAL DE HISTÓRICO ---
        let promptFinal = "";

        if (historico && historico.length > 0) {
            promptFinal = "CONTEXTO DA CONVERSA ATUAL:\n";
            historico.forEach(msg => {
                const autor = msg.role === 'user' ? "Usuário" : "Assistente";
                promptFinal += `[${autor}]: ${msg.content}\n`;
            });
            promptFinal += "\n--- FIM DO CONTEXTO ---\n\n";
            promptFinal += `PERGUNTA ATUAL: ${mensagem}\n\n`;
            promptFinal += "INSTRUÇÃO: Se a PERGUNTA ATUAL for uma confirmação (como 'sim'), use o CONTEXTO acima para dar a resposta detalhada imediatamente.";
        } else {
            promptFinal = mensagem;
        }
        // --------------------------------------------

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
        
        if (data.error) {
            console.error("Erro JSON-RPC da IBM:", data.error);
            return res.status(400).json({ error: "Erro de comunicação com o Agente", detalhes: data.error });
        }

        res.json({ resposta: data.result }); 

    } catch (error) {
        console.error("Erro no Agente:", error);
        res.status(500).json({ error: "O agente do bolão está aquecendo no vestiário." });
    }
});

// =====================================================================
// 5. ROTAS DO FEED SOCIAL (Mural da Resenha, Likes, Replies e Delete)
// =====================================================================

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

app.post('/chat/reply/delete', async (req, res) => {
    try {
        const { msg_id, reply_id, user_email } = req.body;
        
        // Pega o post original
        const doc = (await cloudant.getDocument({ db: DB_NAME, docId: msg_id })).result;

        if (!doc.replies) {
            return res.status(404).json({ success: false, error: 'Nenhuma resposta encontrada' });
        }

        // Acha o índice da resposta específica
        const replyIndex = doc.replies.findIndex(r => r.reply_id === reply_id);
        
        if (replyIndex === -1) {
            return res.status(404).json({ success: false, error: 'Resposta não encontrada' });
        }

        // Verifica se o usuário logado é o dono da resposta
        if (doc.replies[replyIndex].user_email === user_email) {
            // Remove a resposta da array
            doc.replies.splice(replyIndex, 1);

            // Atualiza o documento no banco de dados
            await cloudant.putDocument({ db: DB_NAME, docId: doc._id, document: doc });
            res.status(200).json({ success: true });
        } else {
            res.status(403).json({ success: false, error: 'Não autorizado' });
        }
    } catch (error) {
        console.error("Erro ao apagar resposta:", error);
        res.status(500).json({ success: false, error: 'Erro ao apagar resposta' });
    }
});

// =====================================================================
// 6. INICIALIZAÇÃO DO SERVIDOR
// =====================================================================
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor Node.js (Bolão + Cron + Chat) rodando na porta ${port}`);
});
