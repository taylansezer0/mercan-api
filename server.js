const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();

app.use(cors());
app.use(express.json());

const BASE_URL = "https://eu.mercanoptik.com";

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Mercan API Çalışıyor 🚀"
    });
});

/*
|--------------------------------------------------------------------------
| SearchAll
|--------------------------------------------------------------------------
*/

app.post("/models", async (req, res) => {

    try {

        const models = req.body.models || [];

        if (!models.length) {
            return res.status(400).json({
                success: false,
                message: "Model listesi boş."
            });
        }

        const groups = {};

        await Promise.all(

            models.map(async (model) => {

                const url =
                    `${BASE_URL}/srv/service/product/searchAll/${encodeURIComponent(model)}?language=tr`;

                const response = await axios.get(url);

                groups[model] = response.data.products || [];

            })

        );

        res.json({
            success: true,
            groups
        });

    } catch (e) {

        res.status(500).json({
            success: false,
            error: e.message
        });

    }

});


/*
|--------------------------------------------------------------------------
| Related Products
|--------------------------------------------------------------------------
*/

app.post("/related-products", async (req, res) => {

    try {

        const productIds = req.body.productIds || [];

        if (!productIds.length) {
            return res.status(400).json({
                success: false,
                message: "productIds boş."
            });
        }

        const groups = {};

        await Promise.all(

            productIds.map(async (productId) => {

                try {

                    //------------------------------------------
                    // Önce related-products
                    //------------------------------------------

                    const relatedUrl =
                        `${BASE_URL}/srv/service/product/get-related-products/${productId}/1`;

                    const relatedResponse = await axios.get(relatedUrl);

                    let products = relatedResponse.data.PRODUCTS || [];

                    //------------------------------------------
                    // İlişkili ürün yoksa searchAll fallback
                    //------------------------------------------

                    if (products.length <= 1) {

                        let currentTitle = "";

                        if (products.length) {
                            currentTitle = products[0].TITLE || "";
                        } else {

                            const page = await axios.get(
                                `${BASE_URL}/product/${productId}`
                            ).catch(() => null);

                            if (page?.data?.TITLE) {
                                currentTitle = page.data.TITLE;
                            }

                        }

                        if (currentTitle) {

                            const modelName = currentTitle
                                .replace(/[-].*$/, "")
                                .trim();

                            const searchUrl =
                                `${BASE_URL}/srv/service/product/searchAll/${encodeURIComponent(modelName)}?language=tr`;

                            const searchResponse = await axios.get(searchUrl);

                            products = searchResponse.data.products || [];

                        }

                    }

                    if (!products.length) return;

                    //------------------------------------------
                    // Grup adı
                    //------------------------------------------

                    const first = products[0];

                    const title =
                        first.TITLE ||
                        first.title ||
                        "";

                    const modelName = title
                        .replace(/[-].*$/, "")
                        .trim();

                    groups[modelName] = products;

                }

                catch (err) {

                    console.log(
                        "Related Error:",
                        productId,
                        err.message
                    );

                }

            })

        );

        res.json({

            success: true,

            totalGroups: Object.keys(groups).length,

            groups

        });

    }

    catch (e) {

        res.status(500).json({

            success: false,

            error: e.message

        });

    }

});


/*
|--------------------------------------------------------------------------
| HTML TEST
|--------------------------------------------------------------------------
*/

app.get("/model-page", async (req, res) => {

    try {

        const link = req.query.link || "koleksiyonlar";
        const model = req.query.model;

        if (!model) {

            return res.status(400).json({
                success: false,
                message: "model parametresi gerekli."
            });

        }

        const url =
            `${BASE_URL}/${link}?model=${model}`;

        const response = await axios.get(url, {

            responseType: "text",

            transformResponse: data => data,

            headers: {

                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149 Safari/537.36",

                "Accept": "text/html",

                "Accept-Language": "tr-TR,tr;q=0.9",

                "Referer": `${BASE_URL}/${link}`

            }

        });

        const $ = cheerio.load(response.data);

        const products = [];

        $('[data-toggle="product"]').each((i, el) => {

            products.push({

                id: $(el).attr("data-id"),

                title: $(el)
                    .find('[data-toggle="product-title"]')
                    .text()
                    .trim(),

                href: $(el)
                    .find('[data-toggle="product-url"]')
                    .attr("href")

            });

        });

        res.json({

            success: true,

            count: products.length,

            products

        });

    }

    catch (e) {

        res.status(500).json({

            success: false,

            error: e.message

        });

    }

});


const PORT = process.env.PORT || 3333;

app.listen(PORT, () => {

    console.log(`🚀 API çalışıyor : ${PORT}`);

});