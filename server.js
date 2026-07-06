function log(...text) {

    console.log(
        `[${new Date().toLocaleTimeString()}]`,
        ...text
    );

}
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const MAX_PAGE = 500;
const app = express();

app.use(cors());
app.use(express.json());

const BASE_URL = "https://eu.mercanoptik.com";
const CATEGORY_CACHE_TIME = 1000 * 60 * 30; // 30 dakika

const MODEL_CACHE_TIME = 1000 * 60 * 30; // 30 dakika

const HTML_CACHE_TIME = 1000 * 60 * 30; // 30 dakika

const BATCH_SIZE = 20;

const http = axios.create({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149 Safari/537.36",
        "Accept-Language": "tr-TR,tr;q=0.9"
    }
});

const cache = new Map();

function getCache(key) {

    const item = cache.get(key);

    if (!item) return null;

    if (Date.now() > item.expire) {

        cache.delete(key);

        return null;

    }

    return item.data;

}
const pendingCache = new Map();

async function remember(key, ttl, callback) {

    const cached = getCache(key);

    if (cached) {
        return cached;
    }

    if (pendingCache.has(key)) {

        console.log("⏳ Cache bekleniyor:", key);

        return await pendingCache.get(key);

    }

    const promise = (async () => {

        try {

            const data = await callback();

            setCache(key, data, ttl);

            return data;

        }

        finally {

            pendingCache.delete(key);

        }

    })();

    pendingCache.set(key, promise);

    return await promise;

}


function setCache(key, data, ttl = 1000 * 60 * 30) {

    cache.set(key, {

        expire: Date.now() + ttl,

        data

    });

}
async function getCategoryProducts(blockId, link, page = 1) {

    const response = await http.get(
        `/api/storefront/block/page/${blockId}/products`,
        {
            params: {
                link,
                pg: page,
                language: "tr"
            },
            responseType: "text",
            transformResponse: d => d
        }
    );

    return response.data || "";

}
async function getAllCategoryProducts(blockId, link) {

    const cacheKey = `category_${blockId}_${link}`;

    return remember(

        cacheKey,

        CATEGORY_CACHE_TIME,

        async () => {

            const products = [];
            const ids = new Set();

            let page = 1;

            while (page <= MAX_PAGE) {

                log(`📄 Sayfa ${page} okunuyor...`);

                const html = await getCategoryProducts(
                    blockId,
                    link,
                    page
                );

                const $ = cheerio.load(html);

                const cards = $('[data-toggle="product"][data-id]');

                if (!cards.length) {

                    log("🏁 Son sayfaya ulaşıldı.");

                    break;

                }

                let added = 0;

                cards.each((i, el) => {

                    const id = $(el).attr("data-id");

                    if (!id) return;

                    if (ids.has(id)) return;

                    ids.add(id);

                    products.push({

                        id,

                        title: $(el)
                            .find('[data-toggle="product-title"]')
                            .text()
                            .trim()

                    });

                    added++;

                });

                log(`✔ Sayfa ${page}: ${added} ürün`);

                if (added < 24) {
                    log("🏁 Son sayfaya ulaşıldı.");
                    break;
                }

                page++;

            }

            if (page > MAX_PAGE) {

                log(`⚠ Maksimum sayfa limitine (${MAX_PAGE}) ulaşıldı.`);
                        
            }
            log(`🎉 Toplam ${products.length} ürün bulundu.`);

            return products;

        }

    );

}
function modelName(title = "") {

    return title
        .replace(/[-].*$/, "")
        .trim();

}

app.get("/", (req, res) => {

    res.json({

        success: true,

        message: "Mercan API v3"

    });

});

/*
|--------------------------------------------------------------------------
| Servisler
|--------------------------------------------------------------------------
*/

async function getModelList(link = "koleksiyonlar") {

    const cacheKey = `models_${link}`;

    return remember(
        cacheKey,
        MODEL_CACHE_TIME,
        async () => {

            const response = await http.get(
                "/srv/service/filter/get/filters-variants-categories-brands-price-models-suppliers",
                {
                    params: {
                        link,
                        language: "tr",
                        currency: "TL"
                    }
                }
            );

            return response.data.MODELS || [];

        }
    );

}

async function getRelatedProducts(productId) {

    const response = await http.get(
        `/srv/service/product/get-related-products/${productId}/1`
    );

    return response.data.PRODUCTS || [];

}

async function searchAll(model) {

    const response = await http.get(
        `/srv/service/product/searchAll/${encodeURIComponent(model)}`,
        {
            params: {
                language: "tr"
            }
        }
    );

    return response.data.products || [];

}

function getModelId(models, model) {

    const item = models.find(x => x.NAME === model);

    return item ? item.ID : null;

}

async function resolveModel(productId, models) {

    let products = await getRelatedProducts(productId);

    if (products.length <= 1) {

        const current = products[0];

        if (current?.TITLE) {

            products = await searchAll(
                modelName(current.TITLE)
            );

        }

    }

    if (!products.length) {
        return null;
    }

    const first = products[0];

    const model = modelName(
        first.TITLE || first.title || ""
    );

    return {

        productId,

        model,

        modelId: getModelId(models, model),

        totalProducts: products.length

    };

}

/*
|--------------------------------------------------------------------------
| HTML Loader
|--------------------------------------------------------------------------
*/

async function loadModelHtml(blockId, link, modelId) {

    const cacheKey = `html_${blockId}_${link}_${modelId}`;

    return remember(

        cacheKey,

        HTML_CACHE_TIME,

        async () => {

            const response = await http.get(

                `/api/storefront/block/page/${blockId}/products`,

                {

                    params: {

                        link,

                        model: modelId,

                        language: "tr"

                    },

                    responseType: "text",

                    transformResponse: d => d

                }

            );

            return response.data || "";

        }

    );

}

/*
|--------------------------------------------------------------------------
| Product Card Parser
|--------------------------------------------------------------------------
*/

function parseProductCards(html) {

    const $ = cheerio.load(html);

    const cards = [];
    const ids = new Set();

    $('[data-toggle="product"]').each((i, el) => {

        const id = $(el).attr("data-id");

        if (!id) return;

        if (ids.has(id)) return;

        ids.add(id);

        cards.push($.html(el));

    });

    return {

        total: cards.length,

        html: cards.join("\n")

    };

}

/*
|--------------------------------------------------------------------------
| Model HTML
|--------------------------------------------------------------------------
*/

async function getModelCards(blockId, link, modelId) {

    const html = await loadModelHtml(
        blockId,
        link,
        modelId
    );

    return parseProductCards(html);

}
async function processBatch(items, size, callback) {

    const result = [];

    for (let i = 0; i < items.length; i += size) {

        const batch = items.slice(i, i + size);

        log(
            `📦 Batch ${Math.floor(i / size) + 1} / ${Math.ceil(items.length / size)}`
        );

        const data = await Promise.all(
            batch.map(callback)
        );

        result.push(...data);

    }

    return result;

}
/*
|--------------------------------------------------------------------------
| GROUPED PRODUCTS
|--------------------------------------------------------------------------
*/

app.post("/grouped-products", async (req, res) => {
    const requestId = Math.random().toString(36).slice(2, 8);

    log(`🚀 Request başladı: ${requestId}`);
    try {

        const {

            blockId,
            link = "koleksiyonlar"

        } = req.body;

        if (!blockId) {

            return res.status(400).json({
                success: false,
                message: "blockId gerekli."
            });

        }

        //----------------------------------------
        // Cache'li kategori ürünleri
        //----------------------------------------

        const products = await getAllCategoryProducts(
            blockId,
            link
        );

        if (!products.length) {

            return res.json({
                success: true,
                totalModels: 0,
                items: []
            });

        }

        //----------------------------------------
        // Model listesi
        //----------------------------------------

        const models = await getModelList(link);

        //----------------------------------------
        // Gruplar
        //----------------------------------------

        const groups = new Map();

        for (const product of products) {

            const model = modelName(product.title);

            if (!model) continue;

            if (!groups.has(model)) {

                const modelInfo = models.find(
                    x => x.NAME === model
                );

                groups.set(model, {

                    model,

                    modelId: modelInfo
                        ? modelInfo.ID
                        : null,

                    totalProducts: 0

                });

            }

            groups.get(model).totalProducts++;

        }

        //----------------------------------------
        // HTML'leri çek
        //----------------------------------------

        const items = (
            await processBatch(
            
                [...groups.values()],
            
                BATCH_SIZE,
            
                async group => {
                
                    if (!group.modelId) {
                        return null;
                    }
                
                    const result = await getModelCards(
                    
                        blockId,
                    
                        link,
                    
                        group.modelId
                    
                    );
                
                    return {
                    
                        model: group.model,
                    
                        modelId: group.modelId,
                    
                        total: group.totalProducts,
                    
                        html: result.html
                    
                    };
                
                }
            
            )
        
        ).filter(Boolean);

        log(`✅ Request bitti: ${requestId}`);
        
        res.json({

            success: true,

            totalModels: items.length,

            items

        });

    }

    catch (err) {

        console.error(err);

        res.status(500).json({

            success: false,

            error: err.message

        });

    }

});
/*
|--------------------------------------------------------------------------
| MODELS
|--------------------------------------------------------------------------
*/

app.post("/models", async (req, res) => {

    try {

        const {

            models = []

        } = req.body;

        if (!models.length) {

            return res.status(400).json({

                success: false,

                message: "models boş."

            });

        }

        const result = [];

        for (const model of models) {

            const products = await searchAll(model);

            result.push({

                model,

                total: products.length,

                products

            });

        }

        res.json({

            success: true,

            total: result.length,

            items: result

        });

    }

    catch (err) {

        console.error(err);

        res.status(500).json({

            success: false,

            error: err.message

        });

    }

});
/*
|--------------------------------------------------------------------------
| RELATED PRODUCTS
|--------------------------------------------------------------------------
*/

app.post("/related-products", async (req, res) => {

    try {

        const {

            productIds = [],
            link = "koleksiyonlar"

        } = req.body;

        if (!productIds.length) {

            return res.status(400).json({

                success: false,

                message: "productIds boş."

            });

        }

        const models = await getModelList(link);

        const items = [];

        const visited = new Set();

        for (const productId of productIds) {

            const modelInfo = await resolveModel(
                productId,
                models
            );

            if (!modelInfo) {
                continue;
            }

            if (visited.has(modelInfo.model)) {
                continue;
            }

            visited.add(modelInfo.model);

            items.push(modelInfo);

        }

        res.json({

            success: true,

            total: items.length,

            items

        });

    }

    catch (err) {

        console.error(err);

        res.status(500).json({

            success: false,

            error: err.message

        });

    }

});

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

const PORT = process.env.PORT || 3333;

app.listen(PORT, () => {

    log(`🚀 API çalışıyor : ${PORT}`);

});