'use strict';
const core = require('./song-requests.cjs');
const { RecommendationSongs } = require('./song-recommendations.cjs');
const lyrics = require('./song-lyrics.cjs');
const output = require('./song-output.cjs');
module.exports = { ...core, ...lyrics, ...output, SongRequests: RecommendationSongs };
