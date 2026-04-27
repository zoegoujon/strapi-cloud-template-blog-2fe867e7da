'use strict';
module.exports = (plugin) => {

  // Garde une référence vers la factory originale
  const originalAuthController = plugin.controllers.auth;

  // On remplace par une nouvelle factory qui étend la précédente
  plugin.controllers.auth = ({ strapi }) => {
    const base = originalAuthController({ strapi });

    return {
      ...base,

      /**
       * POST /api/auth/local/fcm
       * Enregistre ou efface le token FCM de l'utilisateur connecté.
       * Body: { token: string | null }
       */
      async saveFCM(ctx) {
        const { token } = ctx.request.body;

        if (token !== null && typeof token !== 'string') {
          return ctx.badRequest('Le champ token doit être une string ou null.');
        }

        // ctx.state.user est rempli par le middleware JWT de Strapi
        if (!ctx.state.user) {
          return ctx.unauthorized('Vous devez être connecté.');
        }

        try {
          const updated = await strapi.entityService.update(
            'plugin::users-permissions.user',
            ctx.state.user.id,
            { data: { fcm: token ?? null } }
          );

          ctx.body = {
            id: updated.id,
            email: updated.email,
            fcm: updated.fcm,
          };
        } catch (err) {
          strapi.log.error('[saveFCM] Erreur :', err);
          ctx.internalServerError('Impossible de sauvegarder le token FCM.');
        }
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
      middlewares: [],
    },
  });

  return plugin;
};