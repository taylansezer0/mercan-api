const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Mercan API Çalışıyor 🚀"
    });
});

/*
|--------------------------------------------------------------------------
| SearchAll (Mevcut çalışan endpoint)
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

        const result = {};

        await Promise.all(
            models.map(async (model) => {

                const url =
                    "https://eu.mercanoptik.com/srv/service/product/searchAll/" +
                    encodeURIComponent(model) +
                    "?language=tr";

                const response = await axios.get(url);

                result[model] = response.data.products || [];

            })
        );

        res.json({
            success: true,
            groups: result
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
            `https://eu.mercanoptik.com/${link}?model=${model}`;

        const response = await axios.get(url, {

            responseType: "text",

            transformResponse: data => data,

            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149 Safari/537.36",
                "Accept": "text/html",
                "Accept-Language": "tr-TR,tr;q=0.9",
                "Referer": `https://eu.mercanoptik.com/${link}`
            }

        });

        res.json({

            success: true,
            status: response.status,
            type: typeof response.data,

            preview:
                typeof response.data === "string"
                    ? response.data.substring(0, 500)
                    : response.data,

            length:
                typeof response.data === "string"
                    ? response.data.length
                    : 0

        });

    } catch (e) {

        res.status(500).json({
            success: false,
            error: e.message
        });

    }

});


const PORT = process.env.PORT || 3333;

app.listen(PORT, () => {
    console.log(`🚀 API çalışıyor: ${PORT}`);
});