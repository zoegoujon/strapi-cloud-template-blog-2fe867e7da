module.exports = {
  register({ strapi }) {
    const userContentType = strapi.contentType('plugin::users-permissions.user');
    
    Object.assign(userContentType.attributes, {
      first_name:   { type: 'string' },
      last_name:    { type: 'string' },
      phone_number: { type: 'string' },
      helloasso_id: { type: 'string' },
      notif_mail:   { type: 'boolean', default: true },
      notif_push:   { type: 'boolean', default: false },
      fcm :          { type: 'string' },
    });
  },
  bootstrap({ strapi }) {},
};

///test