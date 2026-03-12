// ./src/index.js
module.exports = {
  register({ strapi }) {
    const userContentType = strapi.contentType('plugin::users-permissions.user');
    userContentType.attributes = {
      // Spread the existing native attributes to keep them
      ...userContentType.attributes,
      // Add your custom attributes
      first_name:    { type: 'string' },
      last_name:     { type: 'string' },
      phone_number:  { type: 'string' },
      helloasso_id:  { type: 'string' },
      notif_mail:    { type: 'boolean', default: true },
      notif_push:    { type: 'boolean', default: false }
    };
  },
  bootstrap({ strapi }) {},
};