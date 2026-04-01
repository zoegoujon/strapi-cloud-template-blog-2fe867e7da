module.exports = (plugin) => {
  // Sauvegarde le controller original
  const originalAuth = plugin.controllers.auth;

  // Remplace par une factory qui étend le controller original
  plugin.controllers.auth = ({ strapi }) => {
    const controller = typeof originalAuth === 'function'
      ? originalAuth({ strapi })
      : originalAuth;

    return {
      ...controller,
      saveFCM: async (ctx) => {
        const res = await strapi.documents('plugin::users-permissions.user').update({
          documentId: ctx.state.user.documentId,
          data: { fcm: ctx.request.body.token },
        });
        ctx.body = res;
      },
    };
  };

  plugin.routes['content-api'].routes.push({
    method: 'POST',
    path: '/auth/local/fcm',
    handler: 'auth.saveFCM',
    config: {
      prefix: '',
      policies: [],
    },
  });

  return plugin;
};