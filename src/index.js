'use strict';
var admin = require("firebase-admin");
var serviceAccount = require("./chuchoteurs-naovie-firebase-adminsdk-fbsvc-dc7d5dc28e.json");

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
      fcm:          { type: 'string' },
    });
  },

  bootstrap({ strapi }) {
    let firebase = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    // Make Firebase available everywhere
    strapi.firebase = firebase;
    let messaging = firebase.messaging();

    // Envoie une notif à un token précis
    let sendNotification = (fcm, data) => {
      let message = { ...data, token: fcm };
      messaging.send(message)
        .then((res) => console.log('[FCM] sendNotification OK:', res))
        .catch((error) => console.error('[FCM] sendNotification error:', error));
    };

    // Envoie une notif à un topic
    let sendNotificationToTopic = (topic_name, data) => {
      let message = { ...data, topic: topic_name };
      messaging.send(message)
        .then((res) => console.log('[FCM] sendNotificationToTopic OK:', res))
        .catch((error) => console.error('[FCM] sendNotificationToTopic error:', error));
    };

    // Abonne un token à un topic
    let subscribeTopic = (fcm, topic_name) => {
      messaging.subscribeToTopic(fcm, topic_name)
        .then((res) => console.log('[FCM] subscribeTopic OK:', res))
        .catch((error) => console.error('[FCM] subscribeTopic error:', error));
    };

    // Envoie une notif à TOUS les users avec notif_push: true
    let sendToAll = async (data) => {
      try {
        const users = await strapi.entityService.findMany(
          'plugin::users-permissions.user',
          {
            filters: { notif_push: true },
            fields: ['fcm'],
          }
        );

        const tokens = users.map(u => u.fcm).filter(Boolean);

        if (tokens.length === 0) {
          console.log('[FCM] sendToAll: aucun token éligible trouvé');
          return;
        }

        // Découpe en lots de 500 (limite Firebase)
        const chunks = [];
        for (let i = 0; i < tokens.length; i += 500) {
          chunks.push(tokens.slice(i, i + 500));
        }

        for (const chunk of chunks) {
          const response = await messaging.sendEachForMulticast({
            tokens: chunk,
            ...data,
          });
          console.log(`[FCM] sendToAll: ${response.successCount} succès, ${response.failureCount} échecs sur ${chunk.length} tokens`);

          // Nettoyage optionnel des tokens invalides
          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              const failedToken = chunk[idx];
              console.warn('[FCM] Token en échec (à nettoyer) :', failedToken, resp.error?.code);
            }
          });
        }
      } catch (error) {
        console.error('[FCM] sendToAll error:', error);
      }
    };

    // Make the notification functions available everywhere
    strapi.notification = {
      subscribeTopic,
      sendNotificationToTopic,
      sendNotification,
      sendToAll,
    };
  },
};