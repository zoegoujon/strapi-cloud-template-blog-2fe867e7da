'use strict';
var admin = require("firebase-admin");
var serviceAccount = require("./chuchoteurs-naovie-firebase-adminsdk-fbsvc-dc7d5dc28e.json");

function facadeHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.FACADE_SECRET) {
    headers['Authorization'] = `Bearer ${process.env.FACADE_SECRET}`;
  }
  return headers;
}

function facadeBase() {
  return process.env.FACADE_URL || 'http://localhost:3001';
}

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

    const firebase = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    strapi.firebase = firebase;
    const messaging = firebase.messaging();

    // ─── Fonctions FCM directes ─────────────────────────────────────────────

    /** Envoie une notif à un token FCM unique. */
    const sendNotification = (fcm, data) => {
      const message = { ...data, token: fcm };
      messaging.send(message)
        .then((res) => strapi.log.debug('[FCM] sendNotification OK :', res))
        .catch((err) => strapi.log.error('[FCM] sendNotification error :', err));
    };

    /** Envoie une notif à un topic FCM. */
    const sendNotificationToTopic = (topic_name, data) => {
      const message = { ...data, topic: topic_name };
      messaging.send(message)
        .then((res) => strapi.log.debug('[FCM] sendNotificationToTopic OK :', res))
        .catch((err) => strapi.log.error('[FCM] sendNotificationToTopic error :', err));
    };

    /** Abonne un token FCM à un topic. */
    const subscribeTopic = (fcm, topic_name) => {
      messaging.subscribeToTopic(fcm, topic_name)
        .then((res) => strapi.log.debug('[FCM] subscribeTopic OK :', res))
        .catch((err) => strapi.log.error('[FCM] subscribeTopic error :', err));
    };

    /**
     * Envoie une notif à TOUS les users avec notif_push: true.
     * Utilise sendEachForMulticast (lots de 500).
     */
    const sendToAll = async (data) => {
      try {
        const users = await strapi.entityService.findMany(
          'plugin::users-permissions.user',
          { filters: { notif_push: true }, fields: ['fcm'] }
        );

        const tokens = users.map((u) => u.fcm).filter(Boolean);
        if (tokens.length === 0) {
          strapi.log.info('[FCM] sendToAll : aucun token éligible');
          return;
        }

        const chunks = [];
        for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));

        for (const chunk of chunks) {
          const response = await messaging.sendEachForMulticast({ tokens: chunk, ...data });
          strapi.log.info(
            `[FCM] sendToAll : ${response.successCount} succès, ` +
            `${response.failureCount} échecs sur ${chunk.length} tokens`
          );
          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              strapi.log.warn('[FCM] Token en échec :', chunk[idx], resp.error?.code);
            }
          });
        }
      } catch (err) {
        strapi.log.error('[FCM] sendToAll error :', err);
      }
    };

    // Expose les fonctions FCM directes
    strapi.notification = {
      subscribeTopic,
      sendNotificationToTopic,
      sendNotification,
      sendToAll,
    };

    // ─── Fonctions façade (appels HTTP vers port 3001) ──────────────────────

    /**
     * Envoie une notif via la façade (token unique).
     */
    const facadeSend = async (token, notification, data = {}) => {
      try {
        const res = await fetch(`${facadeBase()}/push/send`, {
          method:  'POST',
          headers: facadeHeaders(),
          body:    JSON.stringify({ token, notification, data }),
        });
        const json = await res.json();
        strapi.log.debug('[FACADE] send OK :', json);
        return json;
      } catch (err) {
        strapi.log.error('[FACADE] send error :', err);
      }
    };

    /**
     * Envoie une notif via la façade (multicast).
     */
    const facadeSendMulticast = async (tokens, notification, data = {}) => {
      try {
        const res = await fetch(`${facadeBase()}/push/send-multicast`, {
          method:  'POST',
          headers: facadeHeaders(),
          body:    JSON.stringify({ tokens, notification, data }),
        });
        const json = await res.json();
        strapi.log.debug('[FACADE] send-multicast OK :', json);
        return json;
      } catch (err) {
        strapi.log.error('[FACADE] send-multicast error :', err);
      }
    };

    /**
     * Envoie une notif via la façade (topic).
     */
    const facadeSendTopic = async (topic, notification, data = {}) => {
      try {
        const res = await fetch(`${facadeBase()}/push/send-topic`, {
          method:  'POST',
          headers: facadeHeaders(),
          body:    JSON.stringify({ topic, notification, data }),
        });
        const json = await res.json();
        strapi.log.debug('[FACADE] send-topic OK :', json);
        return json;
      } catch (err) {
        strapi.log.error('[FACADE] send-topic error :', err);
      }
    };

    // Expose les fonctions façade
    strapi.pushFacade = {
      send:          facadeSend,
      sendMulticast: facadeSendMulticast,
      sendTopic:     facadeSendTopic,
    };

    strapi.log.info('[Bootstrap] Firebase initialisé — strapi.notification et strapi.pushFacade disponibles');
  },
};