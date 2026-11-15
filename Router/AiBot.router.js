// Router/AiBot.router.js
const express = require('express');
const router = express.Router();
const { handleAiAction } = require('../Controller/AiBot.controller');

router.post('/ai/action', handleAiAction);

module.exports = router;
