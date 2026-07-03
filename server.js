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

app.get("/model", async (req, res) => {

    try {

        const model = req.query.code;

        if (!model) {
            return res.status(400).json({
                success: false,
                message: "Model kodu gerekli."
            });
        }

        const url =
            "https://eu.mercanoptik.com/srv/service/product/searchAll/" +
            encodeURIComponent(model) +
            "?language=tr";

        const response = await axios.get(url);

        res.json(response.data);

    } catch (e) {

        res.status(500).json({
            success: false,
            error: e.message
        });

    }

});

app.listen(3333, () => {
    console.log("🚀 API çalışıyor: http://localhost:3333");
});