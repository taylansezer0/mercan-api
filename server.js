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
const RELATED_CACHE_TIME = 1000 * 60 * 30; // 30 dakika

const PAGE_BATCH_SIZE = 5;
const MAX_PAGE = 500;
const DEFAULT_LINK = "koleksiyonlar";
const DEFAULT_LANGUAGE = "tr";
const DEFAULT_CURRENCY = "TL";
const PRODUCTS_PER_PAGE = 24;

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
| Log
|--------------------------------------------------------------------------
*/

function log(...text) {
    console.log(`[${new Date().toLocaleTimeString()}]`, ...text);
}

/*
|--------------------------------------------------------------------------
| Memory Cache + Pending Lock
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

    if (cached) {
        return cached;
    }

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

function normalizeLink(link = DEFAULT_LINK) {
    return String(link || DEFAULT_LINK).replace(/^\/+|\/+$/g, "") || DEFAULT_LINK;
}

function normalizeId(id) {
    return String(id || "").trim();
}

function modelName(title = "") {
    return String(title || "")
        .replace(/[-].*$/, "")
        .trim();
}

function uniqueArray(items) {
    return Array.from(new Set(items));
}

function getCardTitle($, el) {
    const title = $(el).find('[data-toggle="product-title"]').text().trim();

    if (title) return title;

    return (
        $(el).find('[data-toggle="product-url"]').attr("title") ||
        $(el).attr("title") ||
        ""
    ).trim();
}

/*
|--------------------------------------------------------------------------
| Home
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Mercan API Çalışıyor 🚀",
        version: "6.0.0",
        mode: "data-only-grouping"
    });
});

/*
|--------------------------------------------------------------------------
| T-Soft Services
|--------------------------------------------------------------------------
*/

async function getModelList(link = DEFAULT_LINK) {
    const normalizedLink = normalizeLink(link);
    const cacheKey = `models_${normalizedLink}`;

    return remember(cacheKey, MODEL_CACHE_TIME, async () => {
        const response = await http.get(
            "/srv/service/filter/get/filters-variants-categories-brands-price-models-suppliers",
            {
                params: {
                    link: normalizedLink,
                    language: DEFAULT_LANGUAGE,
                    currency: DEFAULT_CURRENCY
                }
            }
        );

        return response.data.MODELS || [];
    });
}

async function getRelatedProducts(productId) {
    const id = normalizeId(productId);
    const cacheKey = `related_${id}`;

    return remember(cacheKey, RELATED_CACHE_TIME, async () => {
        const response = await http.get(
            `/srv/service/product/get-related-products/${encodeURIComponent(id)}/1`
        );

        return response.data.PRODUCTS || [];
    });
}

async function searchAll(model) {
    const response = await http.get(
        `/srv/service/product/searchAll/${encodeURIComponent(model)}`,
        {
            params: {
                language: DEFAULT_LANGUAGE
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
            products = await searchAll(modelName(current.TITLE));
        }
    }

    if (!products.length) {
        return null;
    }

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
| Category Page Reader
|--------------------------------------------------------------------------
*/

async function getCategoryProductsHtml(blockId, link, page = 1) {
    const normalizedLink = normalizeLink(link);

    const response = await http.get(
        `/api/storefront/block/page/${encodeURIComponent(blockId)}/products`,
        {
            params: {
                link: normalizedLink,
                pg: page,
                language: DEFAULT_LANGUAGE
            },
            responseType: "text",
            transformResponse: d => d,
            validateStatus: status => status >= 200 && status < 500
        }
    );

    if (response.status >= 400) {
        return "";
    }

    return response.data || "";
}

function parseCategoryPage(html, page) {
    const $ = cheerio.load(html);
    const products = [];

    $('[data-toggle="product"][data-id]').each((i, el) => {
        const id = normalizeId($(el).attr("data-id"));
        const title = getCardTitle($, el);
        const model = modelName(title);

        if (!id || !title || !model) return;

        products.push({
            id,
            title,
            model,
            page
        });
    });

    return products;
}

async function readCategoryPages(blockId, link) {
    const normalizedLink = normalizeLink(link);
    const cacheKey = `category_groups_${blockId}_${normalizedLink}`;

    return remember(cacheKey, CATEGORY_CACHE_TIME, async () => {
        const requestStarted = Date.now();

        log(`🚀 Kategori taraması başladı: block=${blockId}, link=${normalizedLink}`);

        const models = await getModelList(normalizedLink);
        const modelIdMap = new Map(models.map(item => [item.NAME, item.ID]));

        const ids = new Set();
        const groups = new Map();
        const pagesRead = [];

        let page = 1;
        let finished = false;

        while (!finished && page <= MAX_PAGE) {
            const pages = [];

            for (let i = 0; i < PAGE_BATCH_SIZE && page <= MAX_PAGE; i++, page++) {
                pages.push(page);
            }

            log(`📦 Sayfalar okunuyor: ${pages.join(", ")}`);

            const results = await Promise.all(
                pages.map(async currentPage => {
                    const html = await getCategoryProductsHtml(
                        blockId,
                        normalizedLink,
                        currentPage
                    );

                    return {
                        page: currentPage,
                        products: parseCategoryPage(html, currentPage)
                    };
                })
            );

            for (const result of results) {
                const products = result.products;

                if (!products.length) {
                    log(`🏁 Sayfa ${result.page}: boş / son sayfa`);
                    finished = true;
                    break;
                }

                let added = 0;

                for (const product of products) {
                    if (ids.has(product.id)) continue;

                    ids.add(product.id);
                    added++;

                    if (!groups.has(product.model)) {
                        groups.set(product.model, {
                            model: product.model,
                            modelId: modelIdMap.get(product.model) || null,
                            total: 0,
                            productIds: [],
                            pages: []
                        });
                    }

                    const group = groups.get(product.model);
                    group.total++;
                    group.productIds.push(product.id);

                    if (!group.pages.includes(product.page)) {
                        group.pages.push(product.page);
                    }
                }

                pagesRead.push(result.page);

                log(
                    `✔ Sayfa ${result.page}: ${added} yeni ürün / ${products.length} kart`
                );

                if (products.length < PRODUCTS_PER_PAGE) {
                    log(`🏁 Sayfa ${result.page}: son sayfa`);
                    finished = true;
                    break;
                }
            }
        }

        if (page > MAX_PAGE) {
            log(`⚠ Maksimum sayfa limitine (${MAX_PAGE}) ulaşıldı.`);
        }

        const items = Array.from(groups.values())
            .map(group => ({
                ...group,
                productIds: uniqueArray(group.productIds),
                pages: uniqueArray(group.pages).sort((a, b) => a - b)
            }))
            .sort((a, b) => {
                const firstPageA = a.pages[0] || 999999;
                const firstPageB = b.pages[0] || 999999;

                if (firstPageA !== firstPageB) {
                    return firstPageA - firstPageB;
                }

                return a.model.localeCompare(b.model, "tr");
            });

        const duration = Date.now() - requestStarted;

        log(
            `🎉 Tarama tamamlandı: ${ids.size} ürün, ${items.length} model, ${Math.round(duration / 1000)} sn`
        );

        return {
            totalProducts: ids.size,
            totalModels: items.length,
            pagesRead,
            items
        };
    });
}

/*
|--------------------------------------------------------------------------
| Endpoints
|--------------------------------------------------------------------------
*/

app.post("/grouped-products", async (req, res) => {
    const requestId = Math.random().toString(36).slice(2, 8);

    try {
        const {
            blockId,
            link = DEFAULT_LINK
        } = req.body;

        log(`🚀 Request başladı: ${requestId}`);

        if (!blockId) {
            return res.status(400).json({
                success: false,
                message: "blockId gerekli."
            });
        }

        const data = await readCategoryPages(blockId, link);

        log(`✅ Request bitti: ${requestId}`);

        res.json({
            success: true,
            blockId,
            link: normalizeLink(link),
            totalProducts: data.totalProducts,
            totalModels: data.totalModels,
            pagesRead: data.pagesRead,
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
            link = DEFAULT_LINK
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
            const modelInfo = await resolveModel(productId, models);

            if (!modelInfo) continue;
            if (visited.has(modelInfo.model)) continue;

            visited.add(modelInfo.model);
            items.push(modelInfo);
        }

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
| Start
|--------------------------------------------------------------------------
*/

const PORT = process.env.PORT || 3333;

app.listen(PORT, () => {
    log(`🚀 API çalışıyor : ${PORT}`);
});
