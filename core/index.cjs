'use strict';
const core = require('./song-requests.cjs');
const { RecommendationSongs } = require('./song-recommendations.cjs');
module.exports = { ...core, SongRequests: RecommendationSongs };
