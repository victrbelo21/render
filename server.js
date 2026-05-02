// =====================================================================
// CACHE DE NOTÍCIAS (1x por dia, por idioma)
// =====================================================================
const noticiasCache = { pt: null, es: null };
const ultimaDataNoticias = { pt: "", es: "" };

// URLs das APIs secretas da FIFA por idioma
const fifaEndpoints = {
    pt: "https://cxm-api.fifa.com/fifaplusweb/api/sections/news/1aQDyhkYnKhkAW347zYi4Y?locale=pt&limit=16&skip=0",
    es: "https://cxm-api.fifa.com/fifaplusweb/api/sections/news/3MKHU4nyxZtXHrczk5sg1Z?locale=es&limit=16&skip=0" // URL que você encontrou!
};

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
