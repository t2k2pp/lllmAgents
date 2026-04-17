
  const url_mod = require('url');
  export const import_meta_url = typeof __filename !== 'undefined' ? url_mod.pathToFileURL(__filename).href : '';
