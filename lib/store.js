// lib/store.js
//
// Single import point every Netlify Function uses for data access. Picks,
// in order:
//   1. Turso (lib/turso.js)       - if TURSO_DATABASE_URL is set. This is
//      the recommended default: fully free, no Azure AD app registration.
//   2. Microsoft Graph / Excel (lib/graphExcel.js) - if MS_DRIVE_ID and
//      MS_FILE_ID are set instead (legacy path, for teams that specifically
//      want the data living in an Excel workbook on OneDrive/SharePoint).
//   3. Local JSON store (lib/localStore.js) - if neither is configured, so
//      the site runs and is fully clickable before you've finished setup.
//      NOT used in production.

const hasTurso = !!process.env.TURSO_DATABASE_URL;
const hasGraphConfig = !!(process.env.MS_DRIVE_ID && process.env.MS_FILE_ID);

module.exports = hasTurso ? require("./turso") : hasGraphConfig ? require("./graphExcel") : require("./localStore");
