const cheerio = require("cheerio");
console.log(__filename);

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

app.use(cors());

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Mercan API Çalışıyor 🚀"
    });
});

app.get("/category", async (req, res) => {

    try {

        const link = req.query.link || "koleksiyonlar";

        const filterUrl =
            `https://eu.mercanoptik.com/srv/service/filter/get/filters-variants-categories-brands-price-models-suppliers?link=${encodeURIComponent(link)}&language=tr&currency=TL`;

        const filterResponse = await axios.get(filterUrl);

        const models = filterResponse.data.MODELS || [];

        if (!models.length) {
            return res.json({
                success: false,
                message: "Model bulunamadı."
            });
        }

        const firstModel = models[0];

        const pageUrl =
            `https://eu.mercanoptik.com/${link}?model=${firstModel.ID}`;

        const html = await axios.get(pageUrl);

        res.json({
            success: true,
            model: firstModel,
            htmlLength: html.data.length
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
