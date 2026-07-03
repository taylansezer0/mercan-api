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

const PORT = process.env.PORT || 3333;

app.listen(PORT, () => {
    console.log(`🚀 API çalışıyor: ${PORT}`);
});