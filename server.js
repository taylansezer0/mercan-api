const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

/*
|--------------------------------------------------------------------------
| Config
|--------------------------------------------------------------------------
*/

const BASE_URL = "https://eu.mercanoptik.com";
const CATEGORY_CACHE_TIME = 1000 * 60 * 30; // 30 dakika
const MODEL_CACHE_TIME = 1000 * 60 * 30; // 30 dakika
const SEARCH_CACHE_TIME = 1000 * 60 * 30; // 30 dakika
const PAGE_BATCH_SIZE = 5;
const PAGE_SIZE = 24;
const MAX_PAGE = 500;

function log(...text) {
    console.log(`[${new Date().toLocaleTimeString()}]`, ...text);
}

const http = axios.create({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149 Safari/537.36",
        "Accept-Language": "tr-TR,tr;q=0.9"
    }
});

/*
|--------------------------------------------------------------------------
| Cache + Lock
|--------------------------------------------------------------------------
*/

const cache = new Map();
const pendingCache = new Map();

function getCache(key) {
    const item = cache.get(key);

    if (!item) return null;

    if (Date.now() > item.expire) {
        cache.delete(key);
        return null;
    }

    return item.data;
}

function setCache(key, data, ttl = CATEGORY_CACHE_TIME) {
    cache.set(key, {
        expire: Date.now() + ttl,
        data
    });
}

async function remember(key, ttl, callback) {
    const cached = getCache(key);

    if (cached) return cached;

    if (pendingCache.has(key)) {
        log("⏳ Cache bekleniyor:", key);
        return await pendingCache.get(key);
    }

    const promise = (async () => {
        try {
            const data = await callback();
            setCache(key, data, ttl);
            return data;
        } finally {
            pendingCache.delete(key);
        }
    })();

    pendingCache.set(key, promise);
    return await promise;
}

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function modelName(title = "") {
    return String(title)
        .replace(/[-].*$/, "")
        .trim();
}

function normalizeLink(link = "koleksiyonlar") {
    return String(link || "koleksiyonlar")
        .replace(/^\/+|\/+$/g, "") || "koleksiyonlar";
}

function uniqByModel(items) {
    const map = new Map();

    items.forEach(item => {
        if (!item || !item.model) return;
        if (!map.has(item.model)) map.set(item.model, item);
    });

    return [...map.values()];
}

/*
|--------------------------------------------------------------------------
| T-Soft Services
|--------------------------------------------------------------------------
*/

async function getModelList(link = "koleksiyonlar") {
    link = normalizeLink(link);
    const cacheKey = `models_${link}`;

    return remember(cacheKey, MODEL_CACHE_TIME, async () => {
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
    });
}

async function getRelatedProducts(productId) {
    const response = await http.get(
        `/srv/service/product/get-related-products/${productId}/1`
    );

    return response.data.PRODUCTS || [];
}

async function searchAll(model) {
    const cacheKey = `search_${model}`;

    return remember(cacheKey, SEARCH_CACHE_TIME, async () => {
        const response = await http.get(
            `/srv/service/product/searchAll/${encodeURIComponent(model)}`,
            {
                params: {
                    language: "tr"
                }
            }
        );

        return response.data.products || [];
    });
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
            products = await searchAll(modelName(current.TITLE));
        }
    }

    if (!products.length) return null;

    const first = products[0];
    const model = modelName(first.TITLE || first.title || "");

    return {
        productId,
        model,
        modelId: getModelId(models, model),
        totalProducts: products.length
    };
}

/*
|--------------------------------------------------------------------------
| Category Page Fetch + Parser
|--------------------------------------------------------------------------
*/

async function fetchCategoryPageHtml(blockId, link, page = 1) {
    try {
        const response = await http.get(
            `/api/storefront/block/page/${blockId}/products`,
            {
                params: {
                    link,
                    pg: page,
                    language: "tr"
                },
                responseType: "text",
                transformResponse: d => d,
                validateStatus: status => status >= 200 && status < 500
            }
        );

        if (response.status >= 400) {
            log(`⚠ Sayfa ${page} HTTP ${response.status}`);
            return "";
        }

        return response.data || "";
    } catch (err) {
        log(`⚠ Sayfa ${page} alınamadı:`, err.message);
        return "";
    }
}

function parseCardsFromPage(html, modelsMap, seenIds, groups) {
    const $ = cheerio.load(html);
    const cards = $('[data-toggle="product"][data-id]');
    let added = 0;

    cards.each((i, el) => {
        const card = $(el);
        const id = card.attr("data-id");

        if (!id || seenIds.has(id)) return;

        const title = card.find('[data-toggle="product-title"]').text().trim();
        const rawModel = card.attr("data-model") || modelName(title);
        const model = String(rawModel || "").trim();

        if (!model) return;

        seenIds.add(id);

        if (!groups.has(model)) {
            groups.set(model, {
                model,
                modelId: modelsMap.get(model) || null,
                total: 0,
                html: []
            });
        }

        const group = groups.get(model);
        group.total += 1;
        group.html.push($.html(el));
        added += 1;
    });

    return {
        cardCount: cards.length,
        added
    };
}

async function buildGroupedCategory(blockId, link = "koleksiyonlar") {
    link = normalizeLink(link);
    const cacheKey = `grouped_v5_${blockId}_${link}`;

    return remember(cacheKey, CATEGORY_CACHE_TIME, async () => {
        const models = await getModelList(link);
        const modelsMap = new Map(models.map(item => [item.NAME, item.ID]));
        const groups = new Map();
        const seenIds = new Set();

        let page = 1;
        let finished = false;

        log(`🚀 Kategori taraması başladı: block=${blockId}, link=${link}`);

        while (!finished && page <= MAX_PAGE) {
            const pages = [];

            for (let i = 0; i < PAGE_BATCH_SIZE && page <= MAX_PAGE; i++, page++) {
                pages.push(page);
            }

            log(`📦 Sayfalar okunuyor: ${pages.join(", ")}`);

            const results = await Promise.all(
                pages.map(async currentPage => ({
                    page: currentPage,
                    html: await fetchCategoryPageHtml(blockId, link, currentPage)
                }))
            );

            for (const result of results) {
                if (!result.html.trim()) {
                    finished = true;
                    log(`🏁 Sayfa ${result.page}: boş cevap`);
                    break;
                }

                const parsed = parseCardsFromPage(result.html, modelsMap, seenIds, groups);

                log(`✔ Sayfa ${result.page}: ${parsed.added} yeni ürün / ${parsed.cardCount} kart`);

                if (!parsed.cardCount || parsed.added === 0) {
                    finished = true;
                    log(`🏁 Sayfa ${result.page}: yeni ürün yok`);
                    break;
                }

                if (parsed.cardCount < PAGE_SIZE) {
                    finished = true;
                    log(`🏁 Sayfa ${result.page}: son sayfa`);
                    break;
                }
            }
        }

        if (page > MAX_PAGE) {
            log(`⚠ Maksimum sayfa limitine (${MAX_PAGE}) ulaşıldı.`);
        }

        const items = [...groups.values()]
            .map(group => ({
                model: group.model,
                modelId: group.modelId,
                total: group.total,
                html: group.html.join("\n")
            }))
            .filter(item => item.total > 0);

        log(`🎉 Tarama tamamlandı: ${seenIds.size} ürün, ${items.length} model`);

        return {
            totalProducts: seenIds.size,
            totalModels: items.length,
            items
        };
    });
}

/*
|--------------------------------------------------------------------------
| Routes
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Mercan API v5",
        cacheMinutes: 30
    });
});

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

        const data = await buildGroupedCategory(blockId, link);

        log(`✅ Request bitti: ${requestId}`);

        res.json({
            success: true,
            totalProducts: data.totalProducts,
            totalModels: data.totalModels,
            items: data.items
        });
    } catch (err) {
        console.error(err);

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.post("/models", async (req, res) => {
    try {
        const { models = [] } = req.body;

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
    } catch (err) {
        console.error(err);

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

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
        const resolved = [];

        for (const productId of productIds) {
            const modelInfo = await resolveModel(productId, models);
            if (modelInfo) resolved.push(modelInfo);
        }

        const items = uniqByModel(resolved);

        res.json({
            success: true,
            total: items.length,
            items
        });
    } catch (err) {
        console.error(err);

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
*/

const PORT = process.env.PORT || 3333;

app.listen(PORT, () => {
    log(`🚀 API çalışıyor : ${PORT}`);
});
