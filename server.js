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
// CACHE DE NOTÍCIAS (1x por dia, por idioma)
// =====================================================================
const noticiasCache = { pt: null, es: null };
const ultimaDataNoticias = { pt: "", es: "" };

// URLs das APIs secretas da FIFA por idioma
const fifaEndpoints = {
    pt: "https://cxm-api.fifa.com/fifaplusweb/api/sections/news/1aQDyhkYnKhkAW347zYi4Y?locale=pt&limit=16&skip=0",
    es: "https://cxm-api.fifa.com/fifaplusweb/api/sections/news/3MKHU4nyxZtXHrczk5sg1Z?locale=es&limit=16&skip=0" 
};

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
    "costa do marfim": "cote divoire", 
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
            // Garante que o array de jogos manuais existe caso seja um doc antigo
            if (!controleDoc.jogos_manuais) controleDoc.jogos_manuais = [];
        } catch (e) {
            // Se o documento não existir ainda, ele cria um novo para começar o histórico
            controleDoc = { _id: ID_CONTROLE_JOGOS, jogos_processados: [], jogos_manuais: [], type: "config" };
            await cloudant.postDocument({ db: DB_NAME, document: controleDoc });
        }

        // 2. Busca jogos finalizados na API Oficial
        const response = await fetch(`https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED`, {
            headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN }
        });
        
        const data = await response.json();
        
        if (data.errorCode) {
            console.log('❌ Erro na API:', data.message);
            return;
        }
        
        const jogosDaAPI = data.matches || [];
        
        // 3. Filtra apenas os jogos da API que ainda não foram processados
        const jogosOficiais = jogosDaAPI.filter(jogo => !controleDoc.jogos_processados.includes(jogo.id));

        // 4. INJEÇÃO DOS JOGOS MANUAIS DO CLOUDANT (Kill Switch / Override)
        if (controleDoc.jogos_manuais && controleDoc.jogos_manuais.length > 0) {
            controleDoc.jogos_manuais.forEach(jm => {
                // Cria um ID único para esse jogo manual não ficar em loop infinito
                const manualId = `manual_${formatarTexto(jm.time_1)}_${formatarTexto(jm.time_2)}`;
                
                if (!controleDoc.jogos_processados.includes(manualId)) {
                    jogosOficiais.push({
                        id: manualId,
                        isManual: true, // Flag para pularmos a trava de data abaixo
                        homeTeam: { name: jm.time_1 },
                        awayTeam: { name: jm.time_2 },
                        score: { fullTime: { home: jm.placar_1, away: jm.placar_2 } },
                        utcDate: new Date().toISOString() 
                    });
                }
            });
        }

        if (jogosOficiais.length === 0) {
            console.log('✅ Tudo atualizado. Nenhum jogo novo para pontuar.');
            return;
        }

        console.log(`🎯 Encontrados ${jogosOficiais.length} novos jogos para processar (API + Manuais)!`);
        
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

                    // Trava de Data: se for jogo manual, ignora a data e força a validação
                    const bateuData = dataPalpite ? (dataPalpite === dataAPI || j.isManual) : true;

                    // Lógica Bi-direcional (Permite inverter Casa/Fora - Independente de idioma)
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

                    // Verifica se os pontos mudaram OU se o placar oficial ainda não estava salvo
                    if (palpite.pontos_obtidos !== pontosGanhos || palpite.placar_oficial_1 !== placarReal1) {
                        palpite.pontos_obtidos = pontosGanhos;
                        
                        // SALVANDO O PLACAR OFICIAL NO BANCO PARA O FRONT-END
                        palpite.placar_oficial_1 = placarReal1;
                        palpite.placar_oficial_2 = placarReal2;
                        
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
            jogosOficiais.forEach(jogo => controleDoc.jogos_processados.push(jogo.id));
            documentosParaAtualizar.push(controleDoc);

            await cloudant.postBulkDocs({
                db: DB_NAME,
                bulkDocs: { docs: documentosParaAtualizar }
            });
            console.log(`📦 Atualização em massa concluída! ${documentosParaAtualizar.length} documentos salvos.`);
            
        } else if (jogosOficiais.length > 0) {
            jogosOficiais.forEach(jogo => controleDoc.jogos_processados.push(jogo.id));
            await cloudant.putDocument({ db: DB_NAME, docId: controleDoc._id, document: controleDoc });
            console.log('✅ Jogos registrados no controle, mas nenhuma cartela precisou de atualização.');
        }
        
    } catch (error) {
        console.error('❌ Erro no Cron Job:', error);
    }
});

// =====================================================================
// 3. ROTA DE NOTÍCIAS (API FIFA Direta + Cache Bilíngue)
// =====================================================================
app.get('/noticias', async (req, res) => {
    const hoje = new Date().toISOString().split('T')[0];
    
    // Captura o idioma pedido pelo frontend (padrão é 'pt')
    const lang = req.query.lang === 'es' ? 'es' : 'pt';

    // Se já temos cache para o dia de hoje NESTE idioma, entrega instantaneamente
    if (noticiasCache[lang] && ultimaDataNoticias[lang] === hoje) {
        console.log(`📰 Servindo notícias [${lang.toUpperCase()}] da FIFA na velocidade da luz (direto do Cache)!`);
        return res.json({
            status: 'ok',
            articles: noticiasCache[lang].slice(0, 5)
        });
    }

    console.log(`🌐 Primeiro acesso do dia [${lang.toUpperCase()}]! Conectando na API secreta da FIFA...`);

    try {
        const response = await fetch(fifaEndpoints[lang], {
            headers: {
                "accept": "application/json, text/plain, */*",
                "accept-language": lang === 'es' ? "es-ES,es;q=0.9,en;q=0.8" : "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
            }
        });

        if (!response.ok) throw new Error(`A FIFA barrou a porta: ${response.status}`);

        const data = await response.json();

        // Encontra o array de notícias independente do formato da FIFA
        let listaNoticias = Array.isArray(data) ? data : 
                            (data.articles && Array.isArray(data.articles)) ? data.articles : 
                            (data.items && Array.isArray(data.items)) ? data.items : [];
                            
        if (listaNoticias.length === 0) {
            for (let key in data) {
                if (Array.isArray(data[key])) { listaNoticias = data[key]; break; }
            }
        }

        const artigosFormatados = [];

        for (let item of listaNoticias) {
            const titulo = item.title || item.headline || item.name || '';
            let rawLink = item.url || item.link || item.seoPath || item.slug || '';
            let link = '';
            
            if (rawLink) {
                const partes = rawLink.split('/').filter(p => p.length > 0);
                const slug = partes[partes.length - 1];
                // Monta o link final respeitando o idioma
                link = `https://www.fifa.com/${lang}/tournaments/mens/worldcup/canadamexicousa2026/articles/${slug}`;
            }

            let imageUrl = item.image?.src || item.imageUrl || item.thumbnail?.src || item.picture?.url || item.heroImage?.src || '';
            if (imageUrl && !imageUrl.startsWith('http')) imageUrl = `https://digitalhub.fifa.com${imageUrl}`; 

            let categoria = item.roofline || 'FIFA.COM';
            const pubDate = item.date || item.publishedDate || item.publishedAt || new Date().toISOString();

            if (titulo && imageUrl && link) {
                artigosFormatados.push({
                    title: titulo,
                    url: link,
                    urlToImage: imageUrl,
                    source: { name: categoria },
                    publishedAt: pubDate
                });
            }
        }

        console.log(`✅ Extraímos ${artigosFormatados.length} matérias em [${lang.toUpperCase()}]. Salvando no cofre (Cache)!`);

        noticiasCache[lang] = artigosFormatados;
        ultimaDataNoticias[lang] = hoje;

        res.json({ status: 'ok', articles: artigosFormatados.slice(0, 5) });

    } catch (error) {
        console.error(`❌ Erro na API da FIFA [${lang.toUpperCase()}]:`, error);
        
        // Resgate do Cache antigo se a FIFA cair
        if (noticiasCache[lang]) {
            console.log(`⚠️ Servindo cache antigo [${lang.toUpperCase()}] como resgate.`);
            return res.json({ status: 'ok', articles: noticiasCache[lang].slice(0, 5) });
        }
        res.status(500).json({ status: "error", message: "Erro de comunicação com a API da FIFA" });
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
    
    // Devolve os palpites, o álbum E A WISHLIST!
    res.status(200).json({ 
        success: true, 
        palpites: existingDoc ? (existingDoc.palpites_jogos || []) : [], 
        album: existingDoc ? existingDoc.album : null,
        wishlist: existingDoc ? (existingDoc.wishlist || []) : []
    });
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
      if (time_coracao !== undefined && time_coracao !== "") {
          existingDoc.time_coracao = time_coracao;
      }
      if (recorde_embaixadinha !== undefined) {
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
// ROTA DO ÁLBUM (Salvar Wishlist e Abrir Pacote)
// =====================================================================
app.post('/atualizar-wishlist', async (req, res) => {
  try {
    const { user_email, wishlist } = req.body;
    
    const searchResponse = await cloudant.postFind({
      db: DB_NAME,
      selector: { type: { "$eq": "cartela_usuario" }, user_email: { "$eq": user_email } }
    });

    const existingDoc = searchResponse.result.docs[0];

    if (existingDoc) {
      existingDoc.wishlist = wishlist;
      await cloudant.putDocument({ db: DB_NAME, docId: existingDoc._id, document: existingDoc });
      res.status(200).json({ success: true, message: "Wishlist atualizada!" });
    } else {
      res.status(404).json({ success: false, error: 'Usuário não encontrado.' });
    }
  } catch (error) {
    console.error("Erro ao atualizar wishlist:", error);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

app.post('/abrir-pacote', async (req, res) => {
    try {
        const { user_email } = req.body;
        
        const searchResponse = await cloudant.postFind({
            db: DB_NAME,
            selector: { type: { "$eq": "cartela_usuario" }, user_email: { "$eq": user_email } }
        });

        const userDoc = searchResponse.result.docs[0];
        if (!userDoc) return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });

        if (!userDoc.album) {
            userDoc.album = { coladas: [], repetidas: [], ultimo_pacotinho: null };
        }

        const stringSP = new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
        const dataSP = new Date(stringSP);
        dataSP.setHours(dataSP.getHours() - 12);
        
        const ano = dataSP.getFullYear();
        const mes = String(dataSP.getMonth() + 1).padStart(2, '0');
        const dia = String(dataSP.getDate()).padStart(2, '0');
        const cicloAtual = `${ano}-${mes}-${dia}`;
        
        if (userDoc.album.ultimo_pacotinho === cicloAtual) {
            return res.status(400).json({ success: false, error: 'O carteiro só passa ao meio-dia. Volte mais tarde!' });
        }

        const figurinhasSorteadas = [];
        const QTD_POR_PACOTE = 5;

        for (let i = 0; i < QTD_POR_PACOTE; i++) {
            const chance = Math.random() * 100;
            let figurinhaSorteada;

            if (chance < 5) {
                figurinhaSorteada = Math.floor(Math.random() * (86 - 81 + 1)) + 81;
            } else if (chance < 25) {
                figurinhaSorteada = Math.floor(Math.random() * (80 - 61 + 1)) + 61;
            } else {
                figurinhaSorteada = Math.floor(Math.random() * (60 - 1 + 1)) + 1;
            }
            figurinhasSorteadas.push(figurinhaSorteada);
        }

        const novasParaColar = [];
        const novasRepetidas = [];

        figurinhasSorteadas.forEach(fig => {
            if (userDoc.album.coladas.includes(fig) || novasParaColar.includes(fig)) {
                novasRepetidas.push(fig);
                userDoc.album.repetidas.push(fig);
            } else {
                novasParaColar.push(fig);
                userDoc.album.coladas.push(fig);
            }
        });

        userDoc.album.ultimo_pacotinho = cicloAtual;
        await cloudant.putDocument({ db: DB_NAME, docId: userDoc._id, document: userDoc });

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
// 5. ROTAS DO FÓRUM / REDE SOCIAL (MURAL DA TORCIDA)
// =====================================================================

app.get('/forum', async (req, res) => {
    try {
        const response = await cloudant.postFind({
            db: DB_NAME, selector: { type: { "$eq": "thread_forum" } }, limit: 200
        });
        let threads = response.result.docs;
        threads.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        const formattedThreads = threads.map(doc => ({
            id: doc._id, subject: doc.subject, tag: doc.tag,
            author: doc.author_name, author_email: doc.author_email,
            created_at: doc.created_at, messages: doc.messages || []
        }));

        res.status(200).json({ success: true, threads: formattedThreads });
    } catch (error) { res.status(500).json({ success: false, error: 'Erro ao carregar o fórum' }); }
});

app.post('/forum/new-thread', async (req, res) => {
    try {
        const { subject, tag, author_name, author_email, first_msg } = req.body;
        if (!subject || !tag || !author_email || !first_msg) return res.status(400).json({ success: false, error: 'Dados incompletos.' });

        const timestamp = new Date().toISOString();
        const msgId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
        
        const newThread = {
            type: 'thread_forum', subject: subject, tag: tag,
            author_name: author_name || author_email.split('@')[0],
            author_email: author_email, created_at: timestamp,
            messages: [{
                id: msgId, author_name: author_name || author_email.split('@')[0],
                author_email: author_email, text: first_msg,
                timestamp: timestamp, likes: []
            }]
        };

        const response = await cloudant.postDocument({ db: DB_NAME, document: newThread });
        res.status(200).json({ success: true, id: response.result.id });
    } catch (error) { res.status(500).json({ success: false, error: 'Erro ao criar discussão no banco' }); }
});

// --- RESPONDER TÓPICO OU COMENTÁRIO (Suporta 3 níveis) ---
app.post('/forum/reply', async (req, res) => {
    try {
        const { thread_id, parent_msg_id, author_name, author_email, text } = req.body;
        if (!thread_id || !author_email || !text) return res.status(400).json({ success: false });

        const doc = (await cloudant.getDocument({ db: DB_NAME, docId: thread_id })).result;
        const msgId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
        
        const novaMensagem = {
            id: msgId, author_name: author_name || author_email.split('@')[0],
            author_email, text, timestamp: new Date().toISOString(), likes: []
        };

        if (parent_msg_id) {
            // É uma resposta a um comentário específico
            const parent = doc.messages.find(m => m.id === parent_msg_id);
            if (parent) {
                if (!parent.replies) parent.replies = [];
                parent.replies.push(novaMensagem);
            }
        } else {
            // É um comentário direto na discussão
            if (!doc.messages) doc.messages = [];
            // Adiciona a propriedade replies vazia também nos comentários principais
            novaMensagem.replies = []; 
            doc.messages.push(novaMensagem);
        }

        doc.created_at = new Date().toISOString(); // Bump up do tópico
        await cloudant.putDocument({ db: DB_NAME, docId: doc._id, document: doc });
        res.status(200).json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

// --- CURTIR (Suporta Comentários e Respostas Aninhadas) ---
app.post('/forum/message/like', async (req, res) => {
    try {
        const { thread_id, msg_id, reply_id, user_email } = req.body;
        const doc = (await cloudant.getDocument({ db: DB_NAME, docId: thread_id })).result;

        let targetMsg;
        if (reply_id) {
            const parent = doc.messages.find(m => m.id === msg_id);
            if (parent && parent.replies) targetMsg = parent.replies.find(r => r.id === reply_id);
        } else {
            targetMsg = doc.messages.find(m => m.id === msg_id);
        }

        if (targetMsg) {
            if (!targetMsg.likes) targetMsg.likes = [];
            const idx = targetMsg.likes.indexOf(user_email);
            if (idx > -1) targetMsg.likes.splice(idx, 1);
            else targetMsg.likes.push(user_email);
            
            await cloudant.putDocument({ db: DB_NAME, docId: doc._id, document: doc });
            res.status(200).json({ success: true });
        } else { res.status(404).json({ success: false }); }
    } catch (error) { res.status(500).json({ success: false }); }
});

// --- EXCLUIR TÓPICO INTEIRO ---
app.post('/forum/delete', async (req, res) => {
    try {
        const { thread_id, user_email } = req.body;
        const doc = (await cloudant.getDocument({ db: DB_NAME, docId: thread_id })).result;
        
        if (doc.author_email === user_email) {
            await cloudant.deleteDocument({ db: DB_NAME, docId: doc._id, rev: doc._rev });
            res.status(200).json({ success: true });
        } else { res.status(403).json({ success: false }); }
    } catch(e) { res.status(500).json({ success: false }); }
});

// --- EXCLUIR COMENTÁRIO OU RESPOSTA ---
app.post('/forum/message/delete', async (req, res) => {
    try {
        const { thread_id, msg_id, reply_id, user_email } = req.body;
        const doc = (await cloudant.getDocument({ db: DB_NAME, docId: thread_id })).result;
        
        if (reply_id) {
            const msg = doc.messages.find(m => m.id === msg_id);
            if (msg && msg.replies) {
                const repIndex = msg.replies.findIndex(r => r.id === reply_id);
                if (repIndex > -1 && msg.replies[repIndex].author_email === user_email) {
                    msg.replies.splice(repIndex, 1);
                    await cloudant.putDocument({ db: DB_NAME, docId: doc._id, document: doc });
                    return res.status(200).json({ success: true });
                }
            }
        } else {
            const msgIndex = doc.messages.findIndex(m => m.id === msg_id);
            // Importante: garante que não está apagando o index 0 se não quiser que quebre a thread, 
            // mas o front-end manda pra /forum/delete se for a msg principal.
            if (msgIndex > -1 && doc.messages[msgIndex].author_email === user_email) {
                doc.messages.splice(msgIndex, 1);
                await cloudant.putDocument({ db: DB_NAME, docId: doc._id, document: doc });
                return res.status(200).json({ success: true });
            }
        }
        res.status(403).json({ success: false, error: 'Não autorizado' });
    } catch(e) { res.status(500).json({ success: false }); }
});

// =====================================================================
// 6. INICIALIZAÇÃO DO SERVIDOR
// =====================================================================
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor Node.js (Bolão + Cron + Fórum) rodando na porta ${port}`);
});
