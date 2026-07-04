const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();

app.use(cors());
app.use(express.json());

const BASE_URL = "https://eu.mercanoptik.com";

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

function setCache(key, data, ttl = 1000 * 60 * 5) {

    cache.set(key, {

        expire: Date.now() + ttl,

        data

    });

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

    const cached = getCache(cacheKey);

    if (cached) {
        return cached;
    }

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

    const models = response.data.MODELS || [];

    setCache(cacheKey, models, 1000 * 60 * 30);

    return models;

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

async function loadModelHtml(link, modelId) {

    const cacheKey = `html_${link}_${modelId}`;

    const cached = getCache(cacheKey);

    if (cached) {
        return cached;
    }

    const response = await http.get(`/${link}`, {
        params: {
            model: modelId
        },
        responseType: "text",
        transformResponse: d => d
    });

    const html = response.data || "";

    setCache(cacheKey, html);

    return html;

}

/*
|--------------------------------------------------------------------------
| Product Card Parser
|--------------------------------------------------------------------------
*/

function parseProductCards(html) {

    const $ = cheerio.load(html);

    const ids = new Set();

    const cards = [];

    $('[data-toggle="product"]').each((i, el) => {

        const id = $(el).attr("data-id");

        if (!id) return;

        if (ids.has(id)) return;

        ids.add(id);

        cards.push({

            id,

            html: $.html(el)

        });

    });

    return cards;

}

/*
|--------------------------------------------------------------------------
| Model HTML
|--------------------------------------------------------------------------
*/

async function getModelCards(link, modelId) {

    const html = await loadModelHtml(link, modelId);

    const cards = parseProductCards(html);

    return {

        total: cards.length,

        cards

    };

}

/*
|--------------------------------------------------------------------------
| GROUPED PRODUCTS
|--------------------------------------------------------------------------
*/

app.post("/grouped-products", async (req, res) => {

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

        //------------------------------------------
        // Model listesi
        //------------------------------------------

        const models = await getModelList(link);

        //------------------------------------------
        // Aynı modeli iki kez işleme
        //------------------------------------------

        const visited = new Set();

        //------------------------------------------
        // Sonuç
        //------------------------------------------

        const items = [];

        for (const productId of productIds) {

            const modelInfo = await resolveModel(
                productId,
                models
            );

            if (!modelInfo) {
                continue;
            }

            if (!modelInfo.modelId) {
                continue;
            }

            if (visited.has(modelInfo.modelId)) {
                continue;
            }

            visited.add(modelInfo.modelId);

            //------------------------------------------
            // Kartları getir
            //------------------------------------------

            const result = await getModelCards(

                link,

                modelInfo.modelId

            );

            items.push({

                model: modelInfo.model,

                modelId: modelInfo.modelId,

                total: result.total,

                html: result.cards
                    .map(x => x.html)
                    .join("\n")

            });

        }

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

    console.log(`🚀 API çalışıyor : ${PORT}`);

});