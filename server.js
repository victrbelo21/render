const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); 
const cron = require('node-cron');
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
// 3. ROTA DE NOTÍCIAS (Proxy Seguro NewsAPI com Filtros Avançados)
// =====================================================================
app.get('/noticias', async (req, res) => {
    const hoje = new Date().toISOString().split('T')[0]; // Pega a data atual "2026-06-11"

    // Se já temos as notícias guardadas e a data de hoje é a mesma da última busca, não chama a API
    if (noticiasCache && ultimaDataNoticias === hoje) {
        console.log("📰 Servindo notícias do dia direto do cache!");
        return res.json(noticiasCache);
    }

    console.log("🌐 Buscando notícias frescas na NewsAPI para o novo dia...");
    const API_KEY = process.env.NEWS_API_KEY;
    
    const query = encodeURIComponent('Copa do Mundo FIFA 2026');
    const url = `https://newsapi.org/v2/everything?q=${query}&language=pt&sortBy=publishedAt&pageSize=50&apiKey=${API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        console.log("Status NewsAPI:", data.status, "| Total Encontrado:", data.totalResults);

        if (data.status === 'ok' && data.articles && data.articles.length > 0) {
            
            // 1. AS LISTAS NEGRAS (BLACKLISTS)
            const proibidoSites = ['ig', 'terra', 'metrópoles', 'metropoles', 'diariodocentrodomundo', 'pragmatismopolitico', 'abril']; // Nova lista de bloqueio de fontes
            const proibidoApostas = ['casino', 'cassino', 'aposta', 'bet', 'odds'];
            const proibidoFeminino = ['feminina', 'feminino', 'mulheres'];
            const proibidoOutrosAnos = ['2014', '2018', '2022', '2030', '2034', 'qatar', 'catar', 'rússia', 'áfrica do sul'];
            const proibidoOutrosEsportes = ['basquete', 'vôlei', 'tênis', 'futsal', 'rugby', 'fórmula 1', 'esports', 'ginástica', 'olimpíadas'];
            const proibidoTimesBR = ['flamengo', 'corinthians', 'palmeiras', 'são paulo', 'vasco', 'santos', 'cruzeiro', 'atlético-mg', 'grêmio', 'internacional', 'botafogo', 'fluminense', 'brasileirão', 'libertadores'];
            const proibidoPolitica = ['lula', 'bolsonaro', 'congresso', 'stf', 'eleição', 'política', 'governo', 'deputado'];

            // Função auxiliar para checar se alguma palavra da lista está no texto
            const temPalavra = (texto, lista) => lista.some(palavra => texto.includes(palavra));

            // 2. FILTRAGEM DE PENTE FINO
            let artigosValidos = data.articles.filter(article => {
                const titulo = article.title ? article.title.toLowerCase() : '';
                const desc = article.description ? article.description.toLowerCase() : '';
                const textoCompleto = `${titulo} ${desc}`; 
                
                const sourceName = article.source?.name?.toLowerCase() || '';
                const articleUrl = article.url?.toLowerCase() || '';
                
                // Validação Básica
                const basicoOk = article.title && article.title !== '[Removed]' && article.urlToImage && article.description;
                
                // Validação de Tema (Deve ter a ver com copa)
                const falaDeCopa = textoCompleto.includes('copa') || textoCompleto.includes('mundial') || textoCompleto.includes('fifa');

                // Verificando as Blacklists
                const isSiteProibido = proibidoSites.some(site => sourceName.includes(site) || articleUrl.includes(site));
                const isAposta = temPalavra(textoCompleto, proibidoApostas);
                const isFeminino = temPalavra(textoCompleto, proibidoFeminino);
                const isOutroAno = temPalavra(textoCompleto, proibidoOutrosAnos);
                const isOutroEsporte = temPalavra(textoCompleto, proibidoOutrosEsportes);
                const isTimeBR = temPalavra(textoCompleto, proibidoTimesBR);
                const isPolitica = temPalavra(textoCompleto, proibidoPolitica);

                // Só passa se o básico estiver OK, falar de copa, e NÃO bater em NENHUMA blacklist
                return basicoOk && falaDeCopa && !isSiteProibido && !isAposta && !isFeminino && !isOutroAno && !isOutroEsporte && !isTimeBR && !isPolitica;
            });
            
            if (artigosValidos.length > 0) {
                // 3. PRIORIZAÇÃO DE SITES GRANDES (Terra foi removido daqui)
                const sitesPremium = ['globo', 'ge.globo', 'espn', 'cnn'];

                artigosValidos.forEach(article => {
                    const sourceName = article.source?.name?.toLowerCase() || '';
                    const articleUrl = article.url?.toLowerCase() || '';
                    
                    const isPremium = sitesPremium.some(site => sourceName.includes(site) || articleUrl.includes(site));
                    
                    article.score = Math.random() + (isPremium ? 10 : 0);
                });

                artigosValidos.sort((a, b) => b.score - a.score);
                data.articles = artigosValidos.slice(0, 5);
            } else {
                data.articles = []; 
            }
        } else {
            data.articles = []; 
        }
        // Antes de enviar, guarda na memória e salva a data de hoje
        noticiasCache = data;
        ultimaDataNoticias = hoje;
        
        res.json(data);
    } catch (error) {
        console.error("Erro na ponte de notícias:", error);
        res.status(500).json({ status: "error", message: "Falha interna ao buscar notícias" });
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
    res.status(200).json({ success: true, palpites: existingDoc ? (existingDoc.palpites_jogos || []) : [] });
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
