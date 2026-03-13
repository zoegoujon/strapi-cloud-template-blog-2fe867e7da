const Strapi = require('@strapi/strapi');

(async () => {
  const app = await Strapi.createStrapi({ cwd: process.cwd() });
  await app.load();

  const importWordpress = require("../src/scripts/import-wordpress.js");

  await importWordpress.importWordpress(app, "./soutenirnaovie.xml", {
    dryRun: false
  });

  await importWordpress.syncFundingAmounts(app);

  await app.destroy();
})();