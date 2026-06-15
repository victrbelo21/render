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
// CACHE DO RANKING E MONITORAMENTO ONLINE
// =====================================================================
let rankingCache = { pontos: null, recorde: null };
let ultimaAtualizacaoCache = 0;
const TEMPO_CACHE_MINUTOS = 5;
const ID_CONTROLE_JOGOS = 'controle_processamento_jogos';

// Cofre em memória para monitorar IBMers online sem estressar o banco
const usuariosOnline = new Map();

// =====================================================================
// CACHE DE NOTÍCIAS (1x por dia, por idioma)
// =====================================================================
const noticiasCache = { pt: null, es: null };
const ultimaDataNoticias = { pt: "", es: "" };

// =====================================================================
// DICIONÁRIO DE TRADUÇÕES DO SERVIDOR
// =====================================================================
const serverMessages = {
    pt: {
        invalid_data: 'Dados inválidos.',
        deadline_expired: 'Prazo encerrado para os palpites enviados. Alterações recusadas pelo servidor.',
        user_not_found_make_guess: 'Usuário não encontrado. Faça um palpite antes.',
        pack_already_opened: 'Você já abriu seu pacote hoje. Volte ao meio-dia para abrir o próximo!',
        incomplete_data: 'Dados incompletos.',
        invalid_trade: 'Troca inválida.',
        card_not_found: 'Cartela não encontrada.',
        sticker_unavailable: 'Figurinha indisponível.',
        proposal_exists: 'Proposta já existente.',
        user_not_informed: 'Usuário não informado.',
        proposal_unavailable: 'Proposta não disponível.',
        invalid_action: 'Ação inválida.',
        already_counteroffered: 'Já contraofertada.',
        access_denied: 'Acesso negado.',
        invalid_sticker: 'Figurinha inválida.',
        confirmation_unavailable: 'Confirmação indisponível.',
        incomplete_trade: 'Troca incompleta.',
        cards_not_found: 'Cartelas não encontradas.',
        stickers_unavailable: 'Figurinha(s) não disponível(is).'
    },
    es: {
        invalid_data: 'Datos inválidos.',
        deadline_expired: 'Plazo vencido para las predicciones enviadas. Cambios rechazados por el servidor.',
        user_not_found_make_guess: 'Usuario no encontrado. Haz una predicción primero.',
        pack_already_opened: '¡Ya abriste tu sobre hoy. Vuelve mañana para abrir el próximo!',
        incomplete_data: 'Datos incompletos.',
        invalid_trade: 'Intercambio inválido.',
        card_not_found: 'Boleto no encontrado.',
        sticker_unavailable: 'Cromo no disponible.',
        proposal_exists: 'Propuesta ya existente.',
        user_not_informed: 'Usuario no informado.',
        proposal_unavailable: 'Propuesta no disponible.',
        invalid_action: 'Acción inválida.',
        already_counteroffered: 'Ya contraofertada.',
        access_denied: 'Acceso denegado.',
        invalid_sticker: 'Cromo inválido.',
        confirmation_unavailable: 'Confirmación no disponible.',
        incomplete_trade: 'Intercambio incompleto.',
        cards_not_found: 'Boletos no encontrados.',
        stickers_unavailable: 'Cromo(s) no disponible(s).'
    }
};

// Função auxiliar para obter mensagem traduzida
const getMsg = (key, lang = 'pt') => {
    const validLang = (lang === 'es') ? 'es' : 'pt';
    return serverMessages[validLang][key] || serverMessages.pt[key] || key;
};

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
    "bosnia e herzegovina": "bosnia herzegovina",
    "brasil": "brazil",
    "cabo verde": "cape verde islands",
    "canada": "canada",
    "catar": "qatar",
    "colombia": "colombia",
    "costa do marfim": "côte d’ivoire", 
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
    "ri do ira": "iran",
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
    "rd do congo": "congo dr",
    "tchequia": "czechia",
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
    const nomeLimpo = formatarTexto(nomeBR);
    const traduzido = dicionarioTimes[nomeLimpo] || nomeLimpo;
    return formatarTexto(traduzido);
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
// 2. SISTEMAS AUTOMATIZADOS (CRON JOBS)
// =====================================================================

// TRABALHADOR ANTI-SONO: Dispara uma chamada externa a cada 14 minutos para burlar o shutdown do Render Free
cron.schedule('*/14 * * * *', async () => {
    // IMPORTANTE: Configure a variável de ambiente APP_URL no painel do Render (ex: https://seu-app.onrender.com)
    // Se não configurar, ele usará como fallback a URL padrão que você já mapeou.
    const selfUrl = process.env.APP_URL || 'https://render-74qy.onrender.com';
    try {
        const res = await fetch(`${selfUrl}/ranking`);
        if (res.ok) console.log('⏰ [Anti-Sono] Energia injetada! Render impedido de hibernar com sucesso.');
    } catch (error) {
        console.error('⚠️ [Anti-Sono] Erro ao se auto-chamar:', error.message);
    }
});

// TRABALHADOR INVISÍVEL - Recálculo Contínuo de Resultados
cron.schedule('*/30 * * * *', async () => {
    console.log('⚽ Verificando novos resultados da Copa...');

    const aguardar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const executarComRetry = async (operacao, contexto, tentativas = 5, pausaInicialMs = 1500) => {
        for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
            try {
                return await operacao();
            } catch (error) {
                const status = error?.status || error?.statusCode || error?.code || error?.response?.status;
                const erroTransitório =
                    [429, 500, 502, 503, 504].includes(Number(status)) ||
                    ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(error?.code);

                if (!erroTransitório || tentativa === tentativas) {
                    console.error(`❌ Falha definitiva em ${contexto}:`, error.message || error);
                    throw error;
                }

                const pausaMs = pausaInicialMs * tentativa;

                console.warn(
                    `⚠️ ${contexto}: erro transitório ${status || error?.code}. ` +
                    `Tentativa ${tentativa}/${tentativas}. Aguardando ${pausaMs}ms...`
                );

                await aguardar(pausaMs);
            }
        }
    };

    const salvarDocumentosEmLotes = async (documentos, tamanhoLote = 8, pausaMs = 1200) => {
    const mesclarPontuacaoNaCartelaAtual = (docAtual, docCalculado) => {
        if (!Array.isArray(docAtual.palpites_jogos)) {
            docAtual.palpites_jogos = [];
        }

        if (!Array.isArray(docCalculado.palpites_jogos)) {
            docCalculado.palpites_jogos = [];
        }

        docCalculado.palpites_jogos.forEach(palpiteCalculado => {
            const dataCalculada = formatarDataISO(palpiteCalculado.data_jogo);

            const palpiteAtual = docAtual.palpites_jogos.find(p => {
                const mesmoTime1 = formatarTexto(p.time_1) === formatarTexto(palpiteCalculado.time_1);
                const mesmoTime2 = formatarTexto(p.time_2) === formatarTexto(palpiteCalculado.time_2);
                const mesmaData = formatarDataISO(p.data_jogo) === dataCalculada;

                return mesmoTime1 && mesmoTime2 && mesmaData;
            });

            if (!palpiteAtual) return;

            if (palpiteCalculado.placar_oficial_1 !== undefined) {
                palpiteAtual.placar_oficial_1 = palpiteCalculado.placar_oficial_1;
            } else {
                delete palpiteAtual.placar_oficial_1;
            }

            if (palpiteCalculado.placar_oficial_2 !== undefined) {
                palpiteAtual.placar_oficial_2 = palpiteCalculado.placar_oficial_2;
            } else {
                delete palpiteAtual.placar_oficial_2;
            }

            palpiteAtual.pontos_obtidos = palpiteCalculado.pontos_obtidos || 0;
        });

        docAtual.pontos_acumulados = docCalculado.pontos_acumulados || 0;

        if (docCalculado.timestamp_reprocessamento_forcado) {
            docAtual.timestamp_reprocessamento_forcado = docCalculado.timestamp_reprocessamento_forcado;
        }

        return docAtual;
    };

    const mesclarControleAtual = (controleAtual, controleCalculado) => {
        if (!Array.isArray(controleAtual.jogos_processados)) {
            controleAtual.jogos_processados = [];
        }

        if (!Array.isArray(controleCalculado.jogos_processados)) {
            controleCalculado.jogos_processados = [];
        }

        const processadosMesclados = new Set([
            ...controleAtual.jogos_processados.map(id => String(id)),
            ...controleCalculado.jogos_processados.map(id => String(id))
        ]);

        controleAtual.jogos_processados = Array.from(processadosMesclados);

        const estadoManualAtual = JSON.stringify(controleAtual.jogos_manuais || []);
        const estadoManualCalculado = JSON.stringify(controleCalculado.jogos_manuais || []);

        if (estadoManualAtual === estadoManualCalculado) {
            controleAtual.ultimo_estado_manuais = controleCalculado.ultimo_estado_manuais;
        } else {
            console.warn(
                '⚠️ controle_processamento_jogos mudou durante o salvamento. ' +
                'Preservei jogos_manuais atuais do banco.'
            );
        }

        controleAtual.type = controleAtual.type || 'config';

        if (controleCalculado.forcar_gravacao_total === false) {
            controleAtual.forcar_gravacao_total = false;
        }

        if (controleCalculado.ultimo_reprocessamento_forcado) {
            controleAtual.ultimo_reprocessamento_forcado = controleCalculado.ultimo_reprocessamento_forcado;
        }

        return controleAtual;
    };

    const resolverConflitosDoLote = async (falhas, lote, numeroLote) => {
        for (const falha of falhas) {
            if (falha.error !== 'conflict') {
                throw new Error(
                    `Falha não recuperável no lote ${numeroLote}: ${falha.id} - ${falha.error} - ${falha.reason}`
                );
            }

            const docCalculado = lote.find(doc => doc._id === falha.id);

            if (!docCalculado) {
                console.warn(`⚠️ Conflito no lote ${numeroLote}, mas não encontrei o documento original no lote: ${falha.id}`);
                continue;
            }

            console.warn(
                `⚠️ Conflict detectado no documento ${falha.id}. ` +
                `Vou buscar a _rev atual, mesclar os campos necessários e tentar salvar novamente.`
            );

            try {
                const docAtual = (await executarComRetry(
                    () => cloudant.getDocument({
                        db: DB_NAME,
                        docId: falha.id
                    }),
                    `Buscar documento atualizado após conflict - ${falha.id}`,
                    5,
                    1500
                )).result;

                let docParaSalvar;

                if (docAtual._id === ID_CONTROLE_JOGOS) {
                    docParaSalvar = mesclarControleAtual(docAtual, docCalculado);
                } else if (docAtual.type === 'cartela_usuario') {
                    docParaSalvar = mesclarPontuacaoNaCartelaAtual(docAtual, docCalculado);
                } else {
                    console.warn(
                        `⚠️ Documento ${falha.id} não é cartela_usuario nem controle. ` +
                        `Não vou sobrescrever para evitar perda de dados.`
                    );
                    continue;
                }

                await executarComRetry(
                    () => cloudant.putDocument({
                        db: DB_NAME,
                        docId: docParaSalvar._id,
                        document: docParaSalvar
                    }),
                    `Salvar documento recuperado após conflict - ${falha.id}`,
                    5,
                    1500
                );

                console.log(`✅ Conflict recuperado e documento salvo: ${falha.id}`);

            } catch (error) {
                console.error(
                    `❌ Não consegui recuperar o conflict do documento ${falha.id}. ` +
                    `Vou continuar os próximos lotes para não interromper o reprocessamento.`,
                    error.message || error
                );
            }
        }
    };

    let totalSalvosDireto = 0;
    let totalConflitos = 0;

    for (let i = 0; i < documentos.length; i += tamanhoLote) {
        const lote = documentos.slice(i, i + tamanhoLote);
        const numeroLote = Math.floor(i / tamanhoLote) + 1;
        const totalLotes = Math.ceil(documentos.length / tamanhoLote);

        console.log(`💾 Salvando lote ${numeroLote}/${totalLotes} com ${lote.length} documento(s)...`);

        const response = await executarComRetry(
            () => cloudant.postBulkDocs({
                db: DB_NAME,
                bulkDocs: { docs: lote }
            }),
            `Salvamento bulkDocs - lote ${numeroLote}`,
            5,
            1500
        );

        const resultados = response.result || [];
        const falhas = resultados.filter(item => item.error);
        const sucessos = resultados.filter(item => !item.error);

        totalSalvosDireto += sucessos.length;

        if (falhas.length > 0) {
            totalConflitos += falhas.filter(item => item.error === 'conflict').length;

            console.error(`⚠️ ${falhas.length} documento(s) falharam no lote ${numeroLote}:`, falhas);

            await resolverConflitosDoLote(falhas, lote, numeroLote);
        }

        if (i + tamanhoLote < documentos.length) {
            await aguardar(pausaMs);
        }
    }

    console.log(
        `✅ Salvamento em lotes finalizado. ` +
        `${totalSalvosDireto} documento(s) salvos direto. ` +
        `${totalConflitos} conflict(s) tratados.`
    );
};

    const buscarCartelasEmLotes = async (limiteTotal = 3000, tamanhoLote = 150, pausaMs = 1000) => {
        const cartelas = [];
        let bookmark = null;
        let numeroLote = 1;

        while (cartelas.length < limiteTotal) {
            const restante = limiteTotal - cartelas.length;
            const limiteDoLote = Math.min(tamanhoLote, restante);

            const params = {
                db: DB_NAME,
                selector: { type: { "$eq": "cartela_usuario" } },
                limit: limiteDoLote
            };

            if (bookmark) {
                params.bookmark = bookmark;
            }

            console.log(
                `📖 Lendo lote ${numeroLote} de cartelas ` +
                `(${cartelas.length}/${limiteTotal} carregadas até agora)...`
            );

            const response = await executarComRetry(
                () => cloudant.postFind(params),
                `Leitura de cartelas - lote ${numeroLote}`,
                5,
                1500
            );

            const docs = response.result.docs || [];

            if (docs.length === 0) {
                console.log('✅ Leitura finalizada: nenhum documento novo retornado.');
                break;
            }

            cartelas.push(...docs);
            bookmark = response.result.bookmark;

            console.log(
                `✅ Lote ${numeroLote} lido com ${docs.length} cartela(s). ` +
                `Total carregado: ${cartelas.length}/${limiteTotal}`
            );

            if (cartelas.length >= limiteTotal) {
                console.log(`🏁 Limite máximo de ${limiteTotal} cartelas atingido.`);
                break;
            }

            if (docs.length < limiteDoLote) {
                console.log('🏁 Todas as cartelas disponíveis foram carregadas.');
                break;
            }

            await aguardar(pausaMs);
            numeroLote++;
        }

        return cartelas;
    };
    
    try {
    let controleDoc;
    let forcarGravacaoTotal = false;

    try {
        controleDoc = (await cloudant.getDocument({
            db: DB_NAME,
            docId: ID_CONTROLE_JOGOS
        })).result;

        if (!controleDoc.jogos_manuais) controleDoc.jogos_manuais = [];
        if (!controleDoc.jogos_processados) controleDoc.jogos_processados = [];

        forcarGravacaoTotal = controleDoc.forcar_gravacao_total === true;

        if (forcarGravacaoTotal) {
            console.log('🚨 MODO EMERGÊNCIA ATIVO: forcar_gravacao_total=true. Todas as cartelas lidas serão gravadas novamente.');
        }

    } catch (e) {
        controleDoc = {
            _id: ID_CONTROLE_JOGOS,
            jogos_processados: [],
            jogos_manuais: [],
            ultimo_estado_manuais: "[]",
            type: "config",
            forcar_gravacao_total: false
        };

        await cloudant.postDocument({
            db: DB_NAME,
            document: controleDoc
        });
    }

        // =====================================================================
// BUSCA DOS JOGOS FINALIZADOS NA FOOTBALL-DATA
// Se a API externa cair, o cron continua com os jogos manuais.
// =====================================================================
let jogosDaAPI = [];

try {
    const response = await executarComRetry(
    async () => {
        const res = await fetch(`https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED`, {
            headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN }
        });

        if (!res.ok) {
            const erroHttp = new Error(`Football-Data HTTP ${res.status}`);
            erroHttp.status = res.status;
            throw erroHttp;
        }

        return res;
    },
    'Consulta Football-Data API',
    4,
    2000
);

let data = {};

    try {
        data = await response.json();
    } catch (jsonError) {
        console.warn(
            '⚠️ Football-Data respondeu, mas o JSON veio inválido. ' +
            'O cron seguirá apenas com os jogos manuais.',
            jsonError.message || jsonError
        );
        data = {};
    }

    if (data.errorCode) {
        console.log('⚠️ Erro na API Football-Data:', data.message);
    } else {
        jogosDaAPI = Array.isArray(data.matches) ? data.matches : [];
        console.log(`🌐 Football-Data retornou ${jogosDaAPI.length} jogo(s) finalizado(s).`);
    }

} catch (apiError) {
    console.warn(
        '⚠️ Football-Data indisponível nesta execução. ' +
        'O cron seguirá apenas com os jogos manuais do controle_processamento_jogos.',
        apiError.message || apiError
    );
}

const todosJogosFinalizados = [...jogosDaAPI];

        // MÁGICA DO ROLLBACK: Verifica se você deletou ou alterou um jogo manual no Cloudant
        const estadoAtualManuais = JSON.stringify(controleDoc.jogos_manuais);
        let teveAlteracaoManual = false;
        if (controleDoc.ultimo_estado_manuais !== estadoAtualManuais) {
            teveAlteracaoManual = true;
            controleDoc.ultimo_estado_manuais = estadoAtualManuais; // Tira a nova foto
        }

        // INJEÇÃO DOS JOGOS MANUAIS NA LISTA MESTRA
        if (controleDoc.jogos_manuais && controleDoc.jogos_manuais.length > 0) {
            controleDoc.jogos_manuais.forEach(jm => {
                const sufixoData = jm.data_jogo ? `_${jm.data_jogo}` : '';
                const manualId = `manual_${formatarTexto(jm.time_1)}_${formatarTexto(jm.time_2)}${sufixoData}`;
                
                todosJogosFinalizados.push({
                    id: manualId,
                    isManual: true,
                    strictDate: !!jm.data_jogo,
                    homeTeam: { name: jm.time_1 },
                    awayTeam: { name: jm.time_2 },
                    score: { fullTime: { home: jm.placar_1, away: jm.placar_2 } },
                    utcDate: jm.data_jogo || new Date().toISOString() 
                });
            });
        }

        // Filtra quais precisam ser processados *agora* (Novos da API ou qualquer Manual modificado)
// Normaliza IDs para evitar diferença entre número e string: 537327 vs "537327"
if (!Array.isArray(controleDoc.jogos_processados)) {
    controleDoc.jogos_processados = [];
}

const jogosProcessadosNormalizados = new Set(
    controleDoc.jogos_processados.map(id => String(id))
);

const jogosOficiais = todosJogosFinalizados.filter(jogo => {
    if (jogo.isManual) return true;
    return !jogosProcessadosNormalizados.has(String(jogo.id));
});

if (jogosOficiais.length === 0 && !teveAlteracaoManual) {
    console.log('✅ Tudo atualizado. Nenhum jogo novo e nenhum rollback detectado.');
    return;
}

console.log(`🎯 Varrendo cartelas (Alteração manual ou novos jogos detectados)...`);

const cartelas = await buscarCartelasEmLotes(3000, 150, 1000);
const documentosParaAtualizar = [];

// Guarda quais jogos oficiais realmente deram match com pelo menos um palpite.
// Isso evita marcar um jogo oficial como processado se ele veio da API,
// mas não foi encontrado dentro das cartelas.
const jogosOficiaisComMatch = new Set();

// Guarda estatísticas para sabermos exatamente o que aconteceu com cada jogo oficial.
const estatisticasJogosOficiais = {};

jogosOficiais.forEach(jogo => {
    if (jogo.isManual) return;

    const jogoId = String(jogo.id);

    estatisticasJogosOficiais[jogoId] = {
        id: jogoId,
        data_jogo: formatarDataISO(jogo.utcDate),
        time_1: jogo.homeTeam?.name || '',
        time_2: jogo.awayTeam?.name || '',
        placar_1: jogo.score?.fullTime?.home,
        placar_2: jogo.score?.fullTime?.away,
        palpitesEncontrados: 0,
        cartelasAlteradas: 0
    };
});

console.log(`🎟️ Total de cartelas carregadas para recálculo: ${cartelas.length}`);

for (let doc of cartelas) {
    let pontosTotalCalculado = 0;
    let houveMudancaInterna = false;

    if (!doc.palpites_jogos || doc.palpites_jogos.length === 0) continue;

    doc.palpites_jogos.forEach(palpite => {
        const time1Ingles = traduzirTime(palpite.time_1);
        const time2Ingles = traduzirTime(palpite.time_2);
        const dataPalpite = formatarDataISO(palpite.data_jogo);

        const jogoFinalizado = todosJogosFinalizados.find(j => {
            const home = traduzirTime(j.homeTeam.name);
            const away = traduzirTime(j.awayTeam.name);

            // TRAVA DE DATA COM TOLERÂNCIA (± 24h)
            let bateuData = false;
            const dataAPI = formatarDataISO(j.utcDate);

            if (!dataPalpite) {
                bateuData = true;
            } else if (j.isManual && !j.strictDate) {
                bateuData = true;
            } else if (dataAPI) {
                const dPalpite = new Date(dataPalpite + "T12:00:00Z");
                const dAPI = new Date(dataAPI + "T12:00:00Z");
                const diffEmDias = Math.abs(dPalpite - dAPI) / (1000 * 60 * 60 * 24);
                bateuData = (diffEmDias <= 1);
            }

            const ordreExata = (home.includes(time1Ingles) || time1Ingles.includes(home)) &&
                               (away.includes(time2Ingles) || time2Ingles.includes(away));

            const ordreInvertida = (away.includes(time1Ingles) || time1Ingles.includes(away)) &&
                                   (home.includes(time2Ingles) || time2Ingles.includes(home));

            return bateuData && (ordreExata || ordreInvertida);
        });

        if (jogoFinalizado) {
            const home = traduzirTime(jogoFinalizado.homeTeam.name);
            const ordreExata = (home.includes(time1Ingles) || time1Ingles.includes(home));

            let placarReal1 = ordreExata ? jogoFinalizado.score.fullTime.home : jogoFinalizado.score.fullTime.away;
            let placarReal2 = ordreExata ? jogoFinalizado.score.fullTime.away : jogoFinalizado.score.fullTime.home;

            const precisaCalcular = jogosOficiais.some(jo =>
                String(jo.id) === String(jogoFinalizado.id)
            );

            if (precisaCalcular) {
                const jogoIdProcessado = String(jogoFinalizado.id);

                // Se for jogo oficial vindo da Football-Data e deu match com um palpite,
                // registramos isso antes de qualquer cálculo.
                // Assim o controle só marca como processado se pelo menos um palpite foi encontrado.
                if (!jogoFinalizado.isManual) {
                    jogosOficiaisComMatch.add(jogoIdProcessado);

                    if (estatisticasJogosOficiais[jogoIdProcessado]) {
                        estatisticasJogosOficiais[jogoIdProcessado].palpitesEncontrados++;
                    }
                }

                // === NOVA LÓGICA DE PONTUAÇÃO ===
                const palpite1 = palpite.placar_1;
                const palpite2 = palpite.placar_2;
                let pontosGanhos = 0;

                const vencedorReal = placarReal1 > placarReal2 ? 1 : (placarReal1 < placarReal2 ? 2 : 0);
                const vencedorPalpite = palpite1 > palpite2 ? 1 : (palpite1 < palpite2 ? 2 : 0);

                const diffReal = placarReal1 - placarReal2;
                const diffPalpite = palpite1 - palpite2;

                const acertouVencedor = (vencedorReal === vencedorPalpite);
                const acertouUmPlacar = (palpite1 === placarReal1 || palpite2 === placarReal2);
                const acertouDiferenca = (diffReal === diffPalpite);
                const acertouPlacarExato = (palpite1 === placarReal1 && palpite2 === placarReal2);

                if (acertouPlacarExato) {
                    pontosGanhos = 10;
                } else if (acertouVencedor) {
                    if (acertouDiferenca) {
                        pontosGanhos = 7;
                    } else if (acertouUmPlacar) {
                        pontosGanhos = 5;
                    } else {
                        pontosGanhos = 3;
                    }
                }
                // ===================================

                if (
                    palpite.pontos_obtidos !== pontosGanhos ||
                    palpite.placar_oficial_1 !== placarReal1 ||
                    palpite.placar_oficial_2 !== placarReal2
                ) {
                    palpite.pontos_obtidos = pontosGanhos;
                    palpite.placar_oficial_1 = placarReal1;
                    palpite.placar_oficial_2 = placarReal2;
                    houveMudancaInterna = true;

                    if (!jogoFinalizado.isManual && estatisticasJogosOficiais[jogoIdProcessado]) {
                        estatisticasJogosOficiais[jogoIdProcessado].cartelasAlteradas++;
                    }
                }
            }
        } else {
            if (palpite.placar_oficial_1 !== undefined) {
                delete palpite.placar_oficial_1;
                delete palpite.placar_oficial_2;
                palpite.pontos_obtidos = 0;
                houveMudancaInterna = true;
            }
        }

        pontosTotalCalculado += (palpite.pontos_obtidos || 0);
    });

    if (doc.pontos_acumulados !== pontosTotalCalculado || houveMudancaInterna || forcarGravacaoTotal) {
        doc.pontos_acumulados = pontosTotalCalculado;

        if (forcarGravacaoTotal && !houveMudancaInterna) {
            doc.timestamp_reprocessamento_forcado = new Date().toISOString();
        }

        documentosParaAtualizar.push(doc);
    }
}

// Atualiza controle de jogos processados com IDs normalizados.
// Agora, jogo oficial só entra em jogos_processados se realmente deu match
// com pelo menos um palpite nas cartelas.
let controleModificado = teveAlteracaoManual;

Object.values(estatisticasJogosOficiais).forEach(info => {
    console.log(
        `📊 Match oficial ID=${info.id} | ` +
        `${info.time_1} ${info.placar_1} x ${info.placar_2} ${info.time_2} | ` +
        `data=${info.data_jogo} | ` +
        `palpites encontrados=${info.palpitesEncontrados} | ` +
        `cartelas alteradas=${info.cartelasAlteradas}`
    );
});

todosJogosFinalizados.forEach(jogo => {
    if (jogo.isManual) return;

    const jogoId = String(jogo.id);

    if (!jogosProcessadosNormalizados.has(jogoId)) {
        if (!jogosOficiaisComMatch.has(jogoId)) {
            const home = jogo.homeTeam?.name || 'Home indefinido';
            const away = jogo.awayTeam?.name || 'Away indefinido';
            const placarHome = jogo.score?.fullTime?.home;
            const placarAway = jogo.score?.fullTime?.away;

            console.warn(
                `🚫 NÃO marquei o jogo oficial como processado porque ele não deu match em nenhuma cartela: ` +
                `ID=${jogoId} | ${home} ${placarHome} x ${placarAway} ${away} | ` +
                `utcDate=${jogo.utcDate}. ` +
                `Provável problema de nome dos times, ordem ou data_jogo.`
            );

            return;
        }

        controleDoc.jogos_processados.push(jogoId);
        jogosProcessadosNormalizados.add(jogoId);
        controleModificado = true;

        const home = jogo.homeTeam?.name || 'Home indefinido';
        const away = jogo.awayTeam?.name || 'Away indefinido';
        const placarHome = jogo.score?.fullTime?.home;
        const placarAway = jogo.score?.fullTime?.away;

        console.log(
            `✅ Jogo oficial confirmado e marcado como processado: ` +
            `ID=${jogoId} | ${home} ${placarHome} x ${placarAway} ${away}`
        );
    }
});

if (documentosParaAtualizar.length > 0) {
    const documentosParaSalvar = [...documentosParaAtualizar];

    // Atualiza o controle também quando:
    // 1) houve alteração normal no controle; OU
    // 2) o modo emergencial de gravação total estava ativo.
    if (controleModificado || forcarGravacaoTotal) {
        const controleAtualizado = (await executarComRetry(
            () => cloudant.getDocument({
                db: DB_NAME,
                docId: ID_CONTROLE_JOGOS
            }),
            'Buscar _rev atual do controle antes do bulkDocs',
            5,
            1500
        )).result;

        if (!Array.isArray(controleAtualizado.jogos_processados)) {
            controleAtualizado.jogos_processados = [];
        }

        const processadosMesclados = new Set([
            ...controleAtualizado.jogos_processados.map(id => String(id)),
            ...controleDoc.jogos_processados.map(id => String(id))
        ]);

        controleAtualizado.jogos_processados = Array.from(processadosMesclados);

        const estadoManualBanco = JSON.stringify(controleAtualizado.jogos_manuais || []);
        const estadoManualProcessado = JSON.stringify(controleDoc.jogos_manuais || []);

        if (estadoManualBanco === estadoManualProcessado) {
            controleAtualizado.ultimo_estado_manuais = controleDoc.ultimo_estado_manuais;
        } else {
            console.warn(
                '⚠️ jogos_manuais mudou enquanto o cron rodava. ' +
                'Não atualizei ultimo_estado_manuais para não mascarar uma alteração nova.'
            );
        }

        controleAtualizado.type = controleAtualizado.type || 'config';

        if (forcarGravacaoTotal) {
            controleAtualizado.forcar_gravacao_total = false;
            controleAtualizado.ultimo_reprocessamento_forcado = new Date().toISOString();
            console.log('✅ Modo emergência será desligado no controle: forcar_gravacao_total=false.');
        }

        documentosParaSalvar.push(controleAtualizado);
    }

    await salvarDocumentosEmLotes(documentosParaSalvar, 8, 1200);

    rankingCache = { pontos: null, recorde: null };
    ultimaAtualizacaoCache = 0;

    console.log(
        `📦 Atualização/Rollback concluído! ` +
        `${documentosParaAtualizar.length} cartela(s) salvas. ` +
        `${controleModificado || forcarGravacaoTotal ? 'Controle atualizado.' : 'Controle sem alteração.'}`
    );

} else if (controleModificado || forcarGravacaoTotal) {
    const controleAtualizado = (await executarComRetry(
        () => cloudant.getDocument({
            db: DB_NAME,
            docId: ID_CONTROLE_JOGOS
        }),
        'Buscar _rev atual do controle antes do putDocument',
        5,
        1500
    )).result;

    if (!Array.isArray(controleAtualizado.jogos_processados)) {
        controleAtualizado.jogos_processados = [];
    }

    const processadosMesclados = new Set([
        ...controleAtualizado.jogos_processados.map(id => String(id)),
        ...controleDoc.jogos_processados.map(id => String(id))
    ]);

    controleAtualizado.jogos_processados = Array.from(processadosMesclados);

    const estadoManualBanco = JSON.stringify(controleAtualizado.jogos_manuais || []);
    const estadoManualProcessado = JSON.stringify(controleDoc.jogos_manuais || []);

    if (estadoManualBanco === estadoManualProcessado) {
        controleAtualizado.ultimo_estado_manuais = controleDoc.ultimo_estado_manuais;
    } else {
        console.warn(
            '⚠️ jogos_manuais mudou enquanto o cron rodava. ' +
            'Não atualizei ultimo_estado_manuais para não mascarar uma alteração nova.'
        );
    }

    controleAtualizado.type = controleAtualizado.type || 'config';

    if (forcarGravacaoTotal) {
        controleAtualizado.forcar_gravacao_total = false;
        controleAtualizado.ultimo_reprocessamento_forcado = new Date().toISOString();
        console.log('✅ Modo emergência desligado no controle, mesmo sem cartelas alteradas.');
    }

    await executarComRetry(
        () => cloudant.putDocument({
            db: DB_NAME,
            docId: controleAtualizado._id,
            document: controleAtualizado
        }),
        'Salvar controle_processamento_jogos com _rev atual',
        5,
        1500
    );

    rankingCache = { pontos: null, recorde: null };
    ultimaAtualizacaoCache = 0;

    console.log('✅ Controle atualizado. Nenhuma cartela sofreu alteração.');

} else {
    console.log('✅ Tudo certo. Nenhuma alteração nova identificada.');
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
    const lang = req.query.lang === 'es' ? 'es' : 'pt';

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
        if (noticiasCache[lang]) {
            console.log(`⚠️ Servindo cache antigo [${lang.toUpperCase()}] como resgate.`);
            return res.json({ status: 'ok', articles: noticiasCache[lang].slice(0, 5) });
        }
        res.status(500).json({ status: "error", message: "Erro de comunicação com a API da FIFA" });
    }
});

app.post('/salvar-lote', async (req, res) => {
  try {
    const { user_email, user_name, palpites } = req.body;

    const { lang } = req.body;
    if (!user_email || !palpites) {
        return res.status(400).json({ success: false, error: getMsg('invalid_data', lang) });
    }

    const searchResponse = await cloudant.postFind({
      db: DB_NAME,
      selector: {
        type: { "$eq": "cartela_usuario" },
        user_email: { "$eq": user_email }
      }
    });

    const existingDoc = searchResponse.result.docs[0];
    
    // =================================================================
    // 🛡️ MURALHA DE SEGURANÇA (ANTI-FRAUDE DE HORÁRIO ADAPTÁVEL)
    // =================================================================
    const agoraServidor = new Date(); 
    
    const palpitesFinais = existingDoc && existingDoc.palpites_jogos ? [...existingDoc.palpites_jogos] : [];
    let modificacoesValidas = 0;

    palpites.forEach(palpite_recebido => {
        const matchHora = palpite_recebido.horario.match(/(\d{2}):(\d{2})/);
        
        if (palpite_recebido.data_jogo && matchHora) {
            const dataJogoStr = `${palpite_recebido.data_jogo}T${matchHora[1]}:${matchHora[2]}:00-03:00`;
            const dataOficialJogo = new Date(dataJogoStr);
            
            const difMs = dataOficialJogo - agoraServidor;
            const difHoras = difMs / (1000 * 60 * 60);

            const indexExistente = palpitesFinais.findIndex(p => 
                p.time_1 === palpite_recebido.time_1 && p.time_2 === palpite_recebido.time_2
            );

            // A regra de 2h agora é absoluta baseada no fuso de Brasília vindo do HTML
            if (difHoras > 2) {
                if (indexExistente > -1) {
                    palpitesFinais[indexExistente] = palpite_recebido;
                } else {
                    palpitesFinais.push(palpite_recebido);
                }
                modificacoesValidas++;
            } else {
                console.log(`🚨 BLOQUEADO: ${user_email} tentou enviar/alterar o jogo ${palpite_recebido.time_1} x ${palpite_recebido.time_2} com menos de 2h de antecedência.`);
            }
        }
    });

    if (modificacoesValidas === 0 && palpites.length > 0) {
        return res.status(400).json({ success: false, error: getMsg('deadline_expired', lang) });
    }

    if (existingDoc) {
      existingDoc.palpites_jogos = palpitesFinais;
      existingDoc.user_name = user_name;
      existingDoc.timestamp = agoraServidor.toISOString();

      await cloudant.putDocument({ db: DB_NAME, docId: existingDoc._id, document: existingDoc });
      res.status(200).json({ success: true, message: "Cartela updated" });
    } else {
      const novoDocumento = {
        type: "cartela_usuario",
        user_email, 
        user_name, 
        palpites_jogos: palpitesFinais,
        pontos_acumulados: 0,
        palpite_final: null,
        timestamp: agoraServidor.toISOString()
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
    const agora = Date.now();
    const tempoPassado = (agora - ultimaAtualizacaoCache) / 1000 / 60;
    
    // 1. REFRESH DO COFRE: Se o cache expirou ou está vazio, reconstrói as DUAS listas ordenadas
    if (!rankingCache.pontos || !rankingCache.recorde || tempoPassado >= TEMPO_CACHE_MINUTOS) {
        console.log("🐌 Cache expirado. Re-processando massa de 1000 usuários no Cloudant...");
        
        const response = await cloudant.postFind({
          db: DB_NAME,
          selector: { type: { "$eq": "cartela_usuario" } },
          limit: 3500 // Configurado para engolir com folga os seus 3000 usuários estimados
        });

        // Mapeamento limpo da base de dados
        const dadosBrutos = response.result.docs.map(doc => ({
            email: doc.user_email,
            nome: doc.user_name,
            pontos: doc.pontos_acumulados || 0,
            totalPalpites: doc.palpites_jogos ? doc.palpites_jogos.length : 0,
            time_coracao: doc.time_coracao || '', 
            recorde_embaixadinha: doc.recorde_embaixadinha || 0 
        }));

        // GAVETA 1: Pré-ordenação global por Pontos (com desempate em palpites registrados)
        rankingCache.pontos = [...dadosBrutos].sort((a, b) => b.pontos - a.pontos || b.totalPalpites - a.totalPalpites);

        // GAVETA 2: Pré-ordenação global por Recorde de Embaixadinhas (com desempate em pontos)
        rankingCache.recorde = [...dadosBrutos].sort((a, b) => (b.recorde_embaixadinha || 0) - (a.recorde_embaixadinha || 0) || b.pontos - a.pontos);
        
        ultimaAtualizacaoCache = Date.now();
        console.log("🏆 [Cache Duplo] Ambas as listas (Pontos e Recordes) foram indexadas e salvas com sucesso!");
    }

    // 2. CAPTURA DE PARÂMETROS DO FRONT-END
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const sortBy = req.query.sort || 'pontos'; // 'pontos' ou 'recorde'
    
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;

    // 3. SELEÇÃO DA GAVETA CORRETA (Zero processamento de ordenação aqui, já está pronto!)
    const listaPreOrdenada = sortBy === 'recorde' ? rankingCache.recorde : rankingCache.pontos;
    const totalItems = listaPreOrdenada.length;

    // 4. FATIAMENTO CIRÚRGICO DE BANDA (Envia apenas os 25 corretos daquela ordenação mestre)
    const rankingFatiado = listaPreOrdenada.slice(startIndex, endIndex);

    res.status(200).json({ 
        success: true, 
        ranking: rankingFatiado,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
        currentPage: page
    });
  } catch (error) {
    console.error("Erro crítico na rota de ranking paginado:", error);
    res.status(500).json({ success: false, error: 'Erro interno ao processar ranking' });
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
    
    if (existingDoc && existingDoc.album) {
        existingDoc.album.coladas = (existingDoc.album.coladas || []).filter(id => id >= 1 && id <= 88);
        existingDoc.album.repetidas = (existingDoc.album.repetidas || []).filter(id => id >= 1 && id <= 88);
    }
    
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
      res.status(404).json({ success: false, error: 'User not found' });
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
        const { user_email, lang } = req.body;
        
        const searchResponse = await cloudant.postFind({
            db: DB_NAME,
            selector: { type: { "$eq": "cartela_usuario" }, user_email: { "$eq": user_email } }
        });

        const userDoc = searchResponse.result.docs[0];
        if (!userDoc) return res.status(404).json({ success: false, error: getMsg('user_not_found_make_guess', lang) });

        if (!userDoc.album) {
            userDoc.album = { coladas: [], repetidas: [], ultimo_pacotinho: null };
        }

        userDoc.album.coladas = (userDoc.album.coladas || []).filter(id => id >= 1 && id <= 88);
        userDoc.album.repetidas = (userDoc.album.repetidas || []).filter(id => id >= 1 && id <= 88);

        const stringSP = new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
        const dataSP = new Date(stringSP);
        dataSP.setHours(dataSP.getHours() - 12);
        
        const ano = dataSP.getFullYear();
        const mes = String(dataSP.getMonth() + 1).padStart(2, '0');
        const dia = String(dataSP.getDate()).padStart(2, '0');
        const cicloAtual = `${ano}-${mes}-${dia}`;
        
        if (userDoc.album.ultimo_pacotinho === cicloAtual) {
            return res.status(400).json({ success: false, error: getMsg('pack_already_opened', lang) });
        }

        const figurinhasSorteadas = [];
        const QTD_POR_PACOTE = 5;

        const figsSuperRaras = [1, 2, 3, 4, 5, 6];
        const figsRaras = [7, 12, 19, 43, 48, 53, 58, 63, 68, 73, 78];
        const figsIncomuns = [
            8, 9, 10, 11, 13, 14, 15, 16, 17, 18,
            20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
            31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41
        ];
        const figsComuns = [
            44, 45, 46, 54, 55, 56, 64, 65, 66,
            74, 75, 76, 79, 80, 81, 82, 83, 84,
            85, 86, 87, 88, 42, 47, 52, 57, 62, 67, 72, 77
        ];

        for (let i = 0; i < QTD_POR_PACOTE; i++) {
            const chance = Math.random() * 100;
            let poolSorteio = [];

            if (chance < 4) {
                poolSorteio = figsSuperRaras;
            } 
            else if (chance < 16) {
                poolSorteio = figsRaras;
            } 
            else if (chance < 50) {
                poolSorteio = figsIncomuns;
            } 
            else {
                poolSorteio = figsComuns;
            }

            const figurinhaSorteada = poolSorteio[Math.floor(Math.random() * poolSorteio.length)];
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
// ROTA DO AGENTE DE IA NATIVO (IBM Agentic Apps - REST A2A API)
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

        const payload = {
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
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        
        if (!response.ok) {
            console.error("Erro na chamada A2A da IBM:", data);
            return res.status(400).json({ error: "Erro de comunicação com o Agente", detalhes: data });
        }

        res.json({ resposta: data }); 

    } catch (error) {
        console.error("Erro no Agente A2A:", error);
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
            const parent = doc.messages.find(m => m.id === parent_msg_id);
            if (parent) {
                if (!parent.replies) parent.replies = [];
                parent.replies.push(novaMensagem);
            }
        } else {
            if (!doc.messages) doc.messages = [];
            novaMensagem.replies = []; 
            doc.messages.push(novaMensagem);
        }

        doc.created_at = new Date().toISOString();
        await cloudant.putDocument({ db: DB_NAME, docId: doc._id, document: doc });
        res.status(200).json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

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
// 6. ÁREA DE TROCAS
// =====================================================================

async function buscarCartelaUsuario(userEmail) {
    const response = await cloudant.postFind({
        db: DB_NAME,
        selector: {
            type: "cartela_usuario",
            user_email: userEmail
        },
        limit: 1
    });

    return response.result.docs[0] || null;
}

function garantirAlbumValido(doc) {
    if (!doc.album) {
        doc.album = { coladas: [], repetidas: [], ultimo_pacotinho: null };
    }

    if (!Array.isArray(doc.album.coladas)) doc.album.coladas = [];
    if (!Array.isArray(doc.album.repetidas)) doc.album.repetidas = [];
    if (!Array.isArray(doc.wishlist)) doc.wishlist = [];

    return doc;
}

function possuiRepetida(doc, figId) {
    return garantirAlbumValido(doc).album.repetidas.includes(parseInt(figId, 10));
}

function removerUmaRepetida(doc, figId) {
    const id = parseInt(figId, 10);
    const album = garantirAlbumValido(doc).album;
    const index = album.repetidas.indexOf(id);

    if (index === -1) return false;

    album.repetidas.splice(index, 1);
    return true;
}

function adicionarFigurinhaAoAlbum(doc, figId) {
    const id = parseInt(figId, 10);
    const album = garantirAlbumValido(doc).album;

    if (album.coladas.includes(id)) {
        album.repetidas.push(id);
    } else {
        album.coladas.push(id);
    }
}

function ordenarTrocasMaisRecentes(a, b) {
    const dataA = new Date(a.updated_at || a.created_at || a.timestamp || 0).getTime();
    const dataB = new Date(b.updated_at || b.created_at || b.timestamp || 0).getTime();
    return dataB - dataA;
}

app.post('/trade/propose', async (req, res) => {
    try {
        const { proponente_email, proponente_nome, parceiro_email, parceiro_nome, fig_id, lang } = req.body;
        const proponenteFigId = parseInt(fig_id, 10);

        if (!proponente_email || !parceiro_email || !proponenteFigId) return res.status(400).json({ success: false, error: getMsg('incomplete_data', lang) });
        if (proponente_email === parceiro_email) return res.status(400).json({ success: false, error: getMsg('invalid_trade', lang) });

        const docProponente = await buscarCartelaUsuario(proponente_email);
        const docParceiro = await buscarCartelaUsuario(parceiro_email);

        if (!docProponente || !docParceiro) return res.status(404).json({ success: false, error: getMsg('card_not_found', lang) });

        garantirAlbumValido(docProponente);
        garantirAlbumValido(docParceiro);

        if (!possuiRepetida(docProponente, proponenteFigId)) return res.status(400).json({ success: false, error: getMsg('sticker_unavailable', lang) });

        const buscaDuplicada = await cloudant.postFind({
            db: DB_NAME,
            selector: {
                type: "proposta_troca", proponente_email, parceiro_email, proponente_fig_id: proponenteFigId,
                status: { "$in": ["aguardando_contraoferta", "aguardando_confirmacao"] }
            }
        });

        if (buscaDuplicada.result.docs.length > 0) return res.status(400).json({ success: false, error: getMsg('proposal_exists', lang) });

        const agora = new Date().toISOString();
        const proposta = {
            type: "proposta_troca", proponente_email, proponente_nome, parceiro_email, parceiro_nome,
            proponente_fig_id: proponenteFigId, parceiro_fig_id: null, fig_id: proponenteFigId,
            proponente_wishlist_snapshot: docProponente.wishlist || [], parceiro_wishlist_snapshot: docParceiro.wishlist || [],
            status: "aguardando_contraoferta", created_at: agora, updated_at: agora
        };

        await cloudant.postDocument({ db: DB_NAME, document: proposta });
        res.status(200).json({ success: true, message: "Oferta enviada." });
    } catch (error) { res.status(500).json({ success: false, error: "Erro ao registrar proposta." }); }
});

app.post('/trade/inbox', async (req, res) => {
    try {
        const { user_email, lang } = req.body;
        if (!user_email) return res.status(400).json({ success: false, error: getMsg('user_not_informed', lang) });

        const statusAbertos = ["aguardando_contraoferta", "aguardando_confirmacao"];

        const sent = await cloudant.postFind({
            db: DB_NAME,
            selector: { type: "proposta_troca", proponente_email: user_email, status: { "$in": statusAbertos } },
            limit: 100
        });

        const received = await cloudant.postFind({
            db: DB_NAME,
            selector: { type: "proposta_troca", parceiro_email: user_email, status: { "$in": statusAbertos } },
            limit: 100
        });

        res.status(200).json({
            success: true,
            enviadas: sent.result.docs.sort(ordenarTrocasMaisRecentes),
            recebidas: received.result.docs.sort(ordenarTrocasMaisRecentes)
        });
    } catch (error) { res.status(500).json({ success: false, error: "Erro ao buscar propostas." }); }
});

app.post('/trade/respond', async (req, res) => {
    try {
        const { proposta_id, acao, user_email, minha_fig_id, lang } = req.body;
        if (!proposta_id || !acao) return res.status(400).json({ success: false, error: getMsg('incomplete_data', lang) });

        const proposta = (await cloudant.getDocument({ db: DB_NAME, docId: proposta_id })).result;
        const statusAbertos = ["aguardando_contraoferta", "aguardando_confirmacao"];

        if (!statusAbertos.includes(proposta.status)) return res.status(400).json({ success: false, error: getMsg('proposal_unavailable', lang) });

        if (acao === "recusar" || acao === "cancelar") {
            proposta.status = acao === "cancelar" ? "cancelada" : "recusada";
            proposta.updated_at = new Date().toISOString();
            await cloudant.putDocument({ db: DB_NAME, docId: proposta_id, document: proposta });
            return res.json({ success: true, message: "Proposta atualizada." });
        }

        if (acao !== "contraofertar") return res.status(400).json({ success: false, error: getMsg('invalid_action', lang) });
        if (proposta.status !== "aguardando_contraoferta") return res.status(400).json({ success: false, error: getMsg('already_counteroffered', lang) });
        if (user_email && user_email !== proposta.parceiro_email) return res.status(403).json({ success: false, error: getMsg('access_denied', lang) });

        const parceiroFigId = parseInt(minha_fig_id, 10);
        if (!parceiroFigId) return res.status(400).json({ success: false, error: getMsg('invalid_sticker', lang) });

        const docParceiro = await buscarCartelaUsuario(proposta.parceiro_email);
        if (!docParceiro || !possuiRepetida(docParceiro, parceiroFigId)) return res.status(400).json({ success: false, error: getMsg('sticker_unavailable', lang) });

        proposta.parceiro_fig_id = parceiroFigId;
        proposta.status = "aguardando_confirmacao";
        proposta.updated_at = new Date().toISOString();

        await cloudant.putDocument({ db: DB_NAME, docId: proposta_id, document: proposta });
        res.json({ success: true, message: "Contraoferta enviada." });
    } catch (error) { res.status(500).json({ success: false, error: "Falha ao responder." }); }
});

app.post('/trade/confirm', async (req, res) => {
    try {
        const { proposta_id, user_email, acao, lang } = req.body;
        if (!proposta_id || !acao) return res.status(400).json({ success: false, error: getMsg('incomplete_data', lang) });

        const proposta = (await cloudant.getDocument({ db: DB_NAME, docId: proposta_id })).result;
        if (user_email && user_email !== proposta.proponente_email) return res.status(403).json({ success: false, error: getMsg('access_denied', lang) });
        if (proposta.status !== "aguardando_confirmacao") return res.status(400).json({ success: false, error: getMsg('confirmation_unavailable', lang) });

        if (acao === "recusar" || acao === "cancelar") {
            proposta.status = acao === "cancelar" ? "cancelada" : "recusada_pelo_proponente";
            proposta.updated_at = new Date().toISOString();
            await cloudant.putDocument({ db: DB_NAME, docId: proposta_id, document: proposta });
            return res.json({ success: true, message: "Troca encerrada." });
        }

        if (acao !== "confirmar") return res.status(400).json({ success: false, error: getMsg('invalid_action', lang) });

        const proponenteFigId = parseInt(proposta.proponente_fig_id || proposta.fig_id, 10);
        const parceiroFigId = parseInt(proposta.parceiro_fig_id, 10);

        if (!proponenteFigId || !parceiroFigId) return res.status(400).json({ success: false, error: getMsg('incomplete_trade', lang) });

        const docProponente = await buscarCartelaUsuario(proposta.proponente_email);
        const docParceiro = await buscarCartelaUsuario(proposta.parceiro_email);

        if (!docProponente || !docParceiro) return res.status(404).json({ success: false, error: getMsg('cards_not_found', lang) });

        garantirAlbumValido(docProponente);
        garantirAlbumValido(docParceiro);

        if (!possuiRepetida(docProponente, proponenteFigId) || !possuiRepetida(docParceiro, parceiroFigId)) {
            proposta.status = "expirada";
            proposta.updated_at = new Date().toISOString();
            await cloudant.putDocument({ db: DB_NAME, docId: proposta_id, document: proposta });
            return res.status(400).json({ success: false, error: getMsg('stickers_unavailable', lang) });
        }

        removerUmaRepetida(docProponente, proponenteFigId);
        removerUmaRepetida(docParceiro, parceiroFigId);
        adicionarFigurinhaAoAlbum(docProponente, parceiroFigId);
        adicionarFigurinhaAoAlbum(docParceiro, proponenteFigId);

        proposta.status = "confirmada";
        proposta.updated_at = new Date().toISOString();
        proposta.confirmed_at = new Date().toISOString();

        await cloudant.postBulkDocs({ db: DB_NAME, bulkDocs: { docs: [docProponente, docParceiro, proposta] } });
        res.json({ success: true, message: "Troca confirmada!" });
    } catch (error) { res.status(500).json({ success: false, error: "Falha ao confirmar." }); }
});

// =====================================================================
// 8. ROTAS DE ESTATÍSTICAS (DIRETO DA API OFICIAL DA FIFA & 365SCORES)
// =====================================================================

// Mapeamento de Idiomas para a API do 365Scores (31 = PT-BR, 7 = Espanhol)
const scoresLangMap = { pt: 31, es: 14 };

// CONFIGURAÇÃO DO COFRE DE CACHE (Prazo de expiração absoluto de 3 horas)
const CACHE_TTL_ESTATISTICAS = 3 * 60 * 60 * 1000; 

const estatisticasCache = {
    standings: { pt: null, es: null, timestamp: { pt: 0, es: 0 } },
    chaveamento: { pt: null, es: null, timestamp: { pt: 0, es: 0 } },
    elencos: new Map(), // Chave estruturada: "teamId_lang" -> { data, timestamp }
    jogador: new Map()  // Chave estruturada: "playerId_lang" -> { data, timestamp }
};

app.get('/estatisticas/standings', async (req, res) => {
    try {
        const lang = req.query.lang === 'es' ? 'es' : 'pt';
        const agora = Date.now();

        // Verificação de Cache ativo de 3 horas
        if (
            estatisticasCache.standings[lang] &&
            (agora - estatisticasCache.standings.timestamp[lang] < CACHE_TTL_ESTATISTICAS)
        ) {
            console.log(`⚡ [Cache-Estatísticas] Servindo Classificação FIFA [${lang.toUpperCase()}] direto da memória.`);
            return res.status(200).json(estatisticasCache.standings[lang]);
        }

        console.log(`📊 Cache expirado ou vazio! Buscando tabela oficial na API da FIFA [Idioma: ${lang.toUpperCase()}]...`);

        const fifaLanguage = lang === 'es' ? 'es' : 'pt-BR';

        const fetchJsonSeguro = async (url, contexto) => {
            const response = await fetch(url, {
                headers: {
                    "accept": "application/json, text/plain, */*",
                    "accept-language": lang === 'es'
                        ? "es-ES,es;q=0.9,en;q=0.8"
                        : "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
                    "User-Agent": "Mozilla/5.0"
                }
            });

            if (!response.ok) {
                throw new Error(`${contexto} bloqueou com status: ${response.status}`);
            }

            return response.json();
        };

        const extrairIdTime = (team) => {
            if (!team) return null;

            return String(
                team.IdTeam ||
                team.idTeam ||
                team.IdCountry ||
                team.idCountry ||
                team.Id ||
                team.id ||
                team.TeamId ||
                team.teamId ||
                ''
            ).trim() || null;
        };

        const extrairDescricao = (lista, fallback = '') => {
            if (!Array.isArray(lista) || lista.length === 0) return fallback;

            const preferida =
                lista.find(item => item.Locale === 'pt-BR') ||
                lista.find(item => item.Locale === 'es') ||
                lista.find(item => item.Locale === 'en') ||
                lista[0];

            return preferida?.Description || fallback;
        };

        const isNumeroValido = (valor) => {
            return valor !== null && valor !== undefined && valor !== '' && !Number.isNaN(Number(valor));
        };

        const getResultadoDoJogoParaTime = (match, teamId) => {
            const homeId = extrairIdTime(match.HomeTeam);
            const awayId = extrairIdTime(match.AwayTeam);

            if (!homeId || !awayId || !teamId) return null;

            const homeScore =
                isNumeroValido(match.HomeTeamScore) ? Number(match.HomeTeamScore) :
                isNumeroValido(match.HomeTeam?.Score) ? Number(match.HomeTeam.Score) :
                null;

            const awayScore =
                isNumeroValido(match.AwayTeamScore) ? Number(match.AwayTeamScore) :
                isNumeroValido(match.AwayTeam?.Score) ? Number(match.AwayTeam.Score) :
                null;

            // Se ainda não tem placar, o jogo não entrou na forma.
            if (homeScore === null || awayScore === null) return null;

            const winner = match.Winner ? String(match.Winner) : null;

            // Empate
            if (homeScore === awayScore) return 'D';

            // Se a FIFA informou o Winner, usamos ele.
            if (winner) {
                if (String(teamId) === winner) return 'W';
                if (String(teamId) === homeId || String(teamId) === awayId) return 'L';
            }

            // Fallback pelo placar
            if (String(teamId) === homeId) {
                return homeScore > awayScore ? 'W' : 'L';
            }

            if (String(teamId) === awayId) {
                return awayScore > homeScore ? 'W' : 'L';
            }

            return null;
        };

        const montarMapaUltimosResultados = async () => {
            const urlsCalendario = [
                `https://api.fifa.com/api/v3/calendar/17/285023?language=${fifaLanguage}&count=500`,
                `https://api.fifa.com/api/v3/calendar/17/285023/289273?language=${fifaLanguage}&count=500`
            ];

            let calendarioData = null;

            for (const url of urlsCalendario) {
                try {
                    const tentativa = await fetchJsonSeguro(url, 'Calendário FIFA');

                    if (tentativa?.GroupsStages || tentativa?.Groups || tentativa?.Matches) {
                        calendarioData = tentativa;
                        console.log(`✅ Calendário FIFA carregado para últimos resultados: ${url}`);
                        break;
                    }
                } catch (error) {
                    console.warn(`⚠️ Não consegui carregar calendário por esta URL: ${url}`, error.message);
                }
            }

            const mapa = new Map();

            if (!calendarioData) {
                console.warn('⚠️ Não foi possível carregar calendário FIFA. Últimos resultados ficarão como "-".');
                return mapa;
            }

            const matches = [];

            // Estrutura igual ao preview do F12:
            // GroupsStages -> Groups -> Matches
            if (Array.isArray(calendarioData.GroupsStages)) {
                calendarioData.GroupsStages.forEach(stage => {
                    (stage.Groups || []).forEach(group => {
                        (group.Matches || []).forEach(match => {
                            matches.push({
                                ...match,
                                _idGrupo: group.IdGroup,
                                _nomeGrupo: extrairDescricao(group.Name, '')
                            });
                        });
                    });

                    (stage.Matches || []).forEach(match => {
                        matches.push(match);
                    });
                });
            }

            // Fallbacks, caso a FIFA mude a estrutura.
            if (Array.isArray(calendarioData.Groups)) {
                calendarioData.Groups.forEach(group => {
                    (group.Matches || []).forEach(match => {
                        matches.push({
                            ...match,
                            _idGrupo: group.IdGroup,
                            _nomeGrupo: extrairDescricao(group.Name, '')
                        });
                    });
                });
            }

            if (Array.isArray(calendarioData.Matches)) {
                calendarioData.Matches.forEach(match => matches.push(match));
            }

            console.log(`🧮 ${matches.length} jogo(s) encontrados no calendário FIFA para montar últimos resultados.`);

            matches
                .filter(match => {
                    const homeId = extrairIdTime(match.HomeTeam);
                    const awayId = extrairIdTime(match.AwayTeam);

                    const homeScore =
                        isNumeroValido(match.HomeTeamScore) ? Number(match.HomeTeamScore) :
                        isNumeroValido(match.HomeTeam?.Score) ? Number(match.HomeTeam.Score) :
                        null;

                    const awayScore =
                        isNumeroValido(match.AwayTeamScore) ? Number(match.AwayTeamScore) :
                        isNumeroValido(match.AwayTeam?.Score) ? Number(match.AwayTeamScore) :
                        isNumeroValido(match.AwayTeam?.Score) ? Number(match.AwayTeam.Score) :
                        null;

                    return homeId && awayId && homeScore !== null && awayScore !== null;
                })
                .sort((a, b) => {
                    const dataA = new Date(a.Date || a.LocalDate || 0).getTime();
                    const dataB = new Date(b.Date || b.LocalDate || 0).getTime();
                    return dataB - dataA;
                })
                .forEach(match => {
                    const homeId = extrairIdTime(match.HomeTeam);
                    const awayId = extrairIdTime(match.AwayTeam);

                    [homeId, awayId].forEach(teamId => {
                        if (!teamId) return;

                        const resultado = getResultadoDoJogoParaTime(match, teamId);
                        if (!resultado) return;

                        if (!mapa.has(teamId)) mapa.set(teamId, []);

                        const lista = mapa.get(teamId);

                        if (lista.length < 5) {
                            lista.push(resultado);
                        }
                    });
                });

            for (const [teamId, lista] of mapa.entries()) {
                while (lista.length < 5) lista.push('-');
                mapa.set(teamId, lista.slice(0, 5));
            }

            return mapa;
        };

        const fifaUrl = `https://api.fifa.com/api/v3/calendar/17/285023/289273/standing?language=${fifaLanguage}&count=200`;
        const data = await fetchJsonSeguro(fifaUrl, 'Classificação FIFA');

        const tabelaLimpa = {};
        const resultados = data.Results || [];
        const mapaUltimosResultados = await montarMapaUltimosResultados();

        if (resultados.length > 0) {
            resultados.forEach(item => {
                const nomeGrupo = item.Group?.[0]?.Description || 'A';
                const letraGrupo = nomeGrupo
                    .replace('Grupo ', '')
                    .replace('Group ', '')
                    .trim();

                if (!tabelaLimpa[letraGrupo]) tabelaLimpa[letraGrupo] = [];

                const teamId = extrairIdTime(item.Team);
                const ultimosResultados = teamId && mapaUltimosResultados.has(teamId)
                    ? mapaUltimosResultados.get(teamId)
                    : ['-', '-', '-', '-', '-'];

                tabelaLimpa[letraGrupo].push({
                    posicao: item.Position,
                    idTime: teamId,
                    time: item.Team?.Name?.[0]?.Description || 'A definir',
                    escudo: item.Team?.PictureUrl || `https://ui-avatars.com/api/?name=${item.Team?.IdCountry || 'FIFA'}&background=f2f4f8`,
                    pontos: item.Points || 0,
                    jogos: item.Played || 0,
                    vitorias: item.Won || 0,
                    empates: item.Drawn || 0,
                    derrotas: item.Lost || 0,
                    golsPro: item.GoalsFor || 0,
                    golsContra: item.GoalsAgainst || 0,
                    saldo: item.GoalDifference || 0,
                    ultimosResultados
                });
            });

            for (const grupo in tabelaLimpa) {
                tabelaLimpa[grupo].sort((a, b) => a.posicao - b.posicao);
            }

            const respostaFinal = {
                success: true,
                grupos: tabelaLimpa,
                status: 'ativo'
            };

            estatisticasCache.standings[lang] = respostaFinal;
            estatisticasCache.standings.timestamp[lang] = agora;

            res.status(200).json(respostaFinal);
        } else {
            res.status(200).json({
                success: true,
                grupos: {},
                status: 'aguardando_sorteio'
            });
        }
    } catch (error) {
        console.error('❌ Erro ao extrair classificação da FIFA:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao extrair classificação da FIFA.'
        });
    }
});

app.get('/estatisticas/chaveamento', async (req, res) => {
    try {
        const lang = req.query.lang === 'es' ? 'es' : 'pt';
        const agora = Date.now();

        if (estatisticasCache.chaveamento[lang] && (agora - estatisticasCache.chaveamento.timestamp[lang] < CACHE_TTL_ESTATISTICAS)) {
            console.log(`⚡ [Cache-Estatísticas] Servindo Chaveamento Mata-Mata direto da memória.`);
            return res.status(200).json(estatisticasCache.chaveamento[lang]);
        }

        console.log(`🌳 Buscando árvore do mata-mata na API da FIFA [Idioma: ${lang.toUpperCase()}]...`);
        const fifaStagesUrl = `https://api.fifa.com/api/v3/stages?idSeason=285023&language=${lang}`;
        const response = await fetch(fifaStagesUrl);
        if (!response.ok) throw new Error(`A FIFA bloqueou com status: ${response.status}`);
        
        const data = await response.json();
        const stages = data.Results || (Array.isArray(data) ? data : []);

        if (stages.length > 0) {
            const fasesEliminatorias = stages.filter(fase => !fase.IsGroupStage || fase.Name?.[0]?.Description?.toLowerCase().includes('final'));
            const respostaFinal = { success: true, fases: fasesEliminatorias, status: 'ativo' };
            
            estatisticasCache.chaveamento[lang] = respostaFinal;
            estatisticasCache.chaveamento.timestamp[lang] = agora;

            res.status(200).json(respostaFinal);
        } else {
            res.status(200).json({ success: true, fases: [], status: 'aguardando_fase_grupos' });
        }
    } catch (error) { res.status(500).json({ success: false, error: 'Erro ao extrair o chaveamento.' }); }
});

async function buscarPosicoesDetalhadasEmLote(playerIds, langId365) {
    if (!playerIds || playerIds.length === 0) return new Map();

    const mapa = new Map();

    try {
        const ids = playerIds.filter(Boolean).join(',');

        const profileUrl = `https://webws.365scores.com/web/athletes/?appTypeId=5&langId=${langId365}&timezoneName=America%2FSao_Paulo&userCountryId=21&fullDetails=true&athletes=${ids}`;

        const response = await fetch(profileUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0",
                "accept": "application/json"
            }
        });

        if (!response.ok) {
            console.warn(`⚠️ Não foi possível buscar posições detalhadas em lote. Status: ${response.status}`);
            return mapa;
        }

        const data = await response.json();

        (data.athletes || []).forEach((athlete) => {
            const posicaoDetalhada =
                athlete.formationPosition?.name ||
                athlete.position?.name ||
                null;

            if (athlete.id && posicaoDetalhada) {
                mapa.set(String(athlete.id), posicaoDetalhada);
            }
        });

        return mapa;
    } catch (error) {
        console.warn('⚠️ Erro ao buscar posições detalhadas em lote:', error.message);
        return mapa;
    }
}

app.get('/estatisticas/elencos', async (req, res) => {
    try {
        const teamId = req.query.teamId;
        const lang = req.query.lang === 'es' ? 'es' : 'pt';
        const langId365 = scoresLangMap[lang];
        const agora = Date.now();

        if (!teamId) return res.json({ success: true, status: 'aguardando_selecao', selecoes: [] });

        // Validação do cache usando chave composta
        const cacheKey = `${teamId}_${lang}`;
        if (estatisticasCache.elencos.has(cacheKey)) {
            const cachedData = estatisticasCache.elencos.get(cacheKey);
            if (agora - cachedData.timestamp < CACHE_TTL_ESTATISTICAS) {
                console.log(`⚡ [Cache-Estatísticas] Servindo Elenco da seleção ${teamId} [Idioma: ${lang.toUpperCase()}] direto do Cache.`);
                return res.status(200).json(cachedData.data);
            }
        }

        console.log(`👕 Cache vencido! Buscando elenco do time ${teamId} no 365Scores [Idioma: ${lang.toUpperCase()}]...`);
        const scoresUrl = `https://webws.365scores.com/web/squads/?appTypeId=5&langId=${langId365}&timezoneName=America%2FSao_Paulo&userCountryId=21&competitors=${teamId}`;
        const response = await fetch(scoresUrl);
        
        if (!response.ok) throw new Error(`O 365Scores bloqueou com status: ${response.status}`);
        const data = await response.json();
        
        const elenco = [];
        let treinadorEncontrado = false;

        if (data.squads && data.squads.length > 0) {
    const squadDoTime = data.squads.find(s => s.competitorId == teamId) || data.squads[0];

    if (squadDoTime && squadDoTime.athletes) {
        const atletas = squadDoTime.athletes;

        const idsJogadores = atletas
            .filter(atleta => atleta.position && !atleta.position.isStaff && atleta.position.id !== 0)
            .map(atleta => atleta.id)
            .filter(Boolean);

        const posicoesDetalhadasMap = await buscarPosicoesDetalhadasEmLote(idsJogadores, langId365);

        atletas.forEach(atleta => {
            const nascimento = atleta.birthdate ? atleta.birthdate.split('-')[0] : '-';
            let pos = "Indefinido";
            let posicaoDetalhada = null;
            
            if (atleta.position) {
                if (atleta.position.isStaff || atleta.position.id === 0) {
                    pos = lang === 'es' ? "Director Técnico" : "Treinador";
                } else {
                    pos = mapPosicao(atleta.position.id, lang) || atleta.position.name || "Jogador de Linha";
                    posicaoDetalhada = posicoesDetalhadasMap.get(String(atleta.id)) || pos;
                }
            }

            const camisaNum = (atleta.jerseyNum && atleta.jerseyNum !== -1) ? atleta.jerseyNum : '-';
            const imgVersion = atleta.imageVersion ? `v${atleta.imageVersion}/` : '';

            elenco.push({
                id: atleta.id,
                nome: atleta.nameForURL ? atleta.nameForURL.replace(/-/g, ' ') : (atleta.name || "Atleta"),
                posicao: pos,
                posicaoDetalhada: posicaoDetalhada || pos,
                nascimento: nascimento,
                camisa: camisaNum,
                foto: `https://imagecache.365scores.com/image/upload/f_png,w_80,h_80,c_limit,q_auto:eco,dpr_2,d_Athletes:${atleta.id}.png,r_max,c_thumb,g_face,z_0.65/${imgVersion}Athletes/NationalTeam/${atleta.id}`
            });

            if (atleta.position && (atleta.position.isStaff || atleta.position.id === 0)) treinadorEncontrado = true;
        });
    }
}

        if (!treinadorEncontrado && elenco.length > 0) {
             elenco.push({
                 nome: lang === 'es' ? "No informado oficialmente" : "Não informado oficialmente", 
                 posicao: lang === 'es' ? "Director Técnico" : "Treinador", 
                 nascimento: "-", camisa: "-",
                 foto: `https://ui-avatars.com/api/?name=Treinador&background=f2f4f8`
             });
        }

        const respostaFinal = { success: true, status: 'ativo', elenco: elenco };
        
        // Armazena o registro completo no Map
        estatisticasCache.elencos.set(cacheKey, { data: respostaFinal, timestamp: agora });

        res.status(200).json(respostaFinal);
    } catch (error) { res.status(500).json({ success: false, error: 'Erro ao extrair elenco.' }); }
});

// CONFIGURAÇÃO: Nova lógica dinâmica de tradução baseada no idioma selecionado
function mapPosicao(typeId, lang) {
    const posicoes = {
        pt: { 1: "Goleiro", 2: "Defensor", 3: "Meio-campo", 4: "Atacante", 5: "Treinador" },
        es: { 1: "Arquero", 2: "Defensor", 3: "Centrocampista", 4: "Delantero", 5: "Director Técnico" }
    };
    return posicoes[lang][typeId] || "Indefinido";
}

app.get('/estatisticas/jogador', async (req, res) => {
    try {
        const playerId = req.query.id;
        const lang = req.query.lang === 'es' ? 'es' : 'pt';
        const langId365 = scoresLangMap[lang];
        const agora = Date.now();

        if (!playerId) return res.status(400).json({ success: false, error: 'ID do jogador não informado' });

        const cacheKey = `${playerId}_${lang}`;
        if (estatisticasCache.jogador.has(cacheKey)) {
            const cachedData = estatisticasCache.jogador.get(cacheKey);
            if (agora - cachedData.timestamp < CACHE_TTL_ESTATISTICAS) {
                console.log(`⚡ [Cache-Estatísticas] Servindo Atleta ${playerId} [Idioma: ${lang.toUpperCase()}] direto do Cache.`);
                return res.status(200).json(cachedData.data);
            }
        }

        console.log(`🏃 Buscando perfil completo do jogador ${playerId} no 365Scores [Idioma: ${lang.toUpperCase()}]...`);
        const profileUrl = `https://webws.365scores.com/web/athletes/?appTypeId=5&langId=${langId365}&timezoneName=America%2FSao_Paulo&userCountryId=21&fullDetails=true&athletes=${playerId}`;
        
        let resProfile = await fetch(profileUrl, { headers: { "User-Agent": "Mozilla/5.0", "accept": "application/json" }});
        if (!resProfile.ok) throw new Error(`Status HTTP 1: ${resProfile.status}`);
        let dataProfile = await resProfile.json();
        
        if (dataProfile && dataProfile.competitions && dataProfile.competitions.length > 0) {
            const compIds = dataProfile.competitions.map(c => c.id).join(',');
            const compPrincipal = dataProfile.competitions[0].id;
            const statsUrl = `${profileUrl}&competitions=${compIds}&competitionId=${compPrincipal}`;
            
            let resStats = await fetch(statsUrl, { headers: { "User-Agent": "Mozilla/5.0", "accept": "application/json" }});
            if (resStats.ok) {
                let dataStats = await resStats.json();
                if (dataStats.athletes && dataStats.athletes[0] && dataProfile.athletes && dataProfile.athletes[0]) {
                    dataProfile.athletes[0].highlightStats = dataStats.athletes[0].highlightStats;
                }
            }
        }

        const gamesUrl = `https://webws.365scores.com/web/athletes/games/?appTypeId=5&langId=${langId365}&timezoneName=America%2FSao_Paulo&userCountryId=21&athleteId=${playerId}`;
        let resGames = await fetch(gamesUrl, { headers: { "User-Agent": "Mozilla/5.0", "accept": "application/json" }});
        if (resGames.ok) {
            let dataGames = await resGames.json();
            dataProfile.games = dataGames.games || [];
            
            if (dataGames.competitors) {
                if (!dataProfile.competitors) dataProfile.competitors = [];
                const existingCompIds = new Set(dataProfile.competitors.map(c => c.id));
                dataGames.competitors.forEach(c => {
                    if (!existingCompIds.has(c.id)) {
                        dataProfile.competitors.push(c);
                    }
                });
            }
        }

        // Salva os dados unificados no cache antes de responder
        estatisticasCache.jogador.set(cacheKey, { data: dataProfile, timestamp: agora });

        res.status(200).json(dataProfile);

    } catch (error) {
        console.error("❌ Erro ao buscar jogador:", error);
        res.status(500).json({ success: false, error: 'Erro de comunicação' });
    }
});

// =====================================================================
// 9. INICIALIZAÇÃO DO SERVIDOR
// =====================================================================
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor Node.js rodando na porta ${port}`);
});
