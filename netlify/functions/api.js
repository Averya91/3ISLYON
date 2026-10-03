const serverless = require('serverless-http');
const app = require('../../server/index');

// Netlify forwards /api/* to this function. Express keeps the original
// request path, so all existing /api/... routes continue to work unchanged.
module.exports.handler = serverless(app);
