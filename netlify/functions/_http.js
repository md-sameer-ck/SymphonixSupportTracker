// netlify/functions/_http.js — tiny response helpers shared by every function.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Passcode",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

function json(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(data),
  };
}

function handleOptions() {
  return { statusCode: 204, headers: CORS_HEADERS, body: "" };
}

module.exports = { json, handleOptions, CORS_HEADERS };
