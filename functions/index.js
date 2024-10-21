// Importaciones y configuraciones iniciales
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { Timestamp } = require('firebase-admin/firestore');
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

let clients = functions.config().meta.clients;

if (typeof clients === 'string') {
  clients = JSON.parse(clients);
}

if (!clients) {
  logger.error('❌ Las variables de configuración no están definidas. Asegúrate de configurar functions.config().meta.clients correctamente.');
  throw new Error('Variables de configuración no definidas');
}

// Función para obtener las métricas según el tipo de medio
function getMetricsForMediaType(mediaType) {
  mediaType = mediaType.toLowerCase().trim();

  if (mediaType === 'image' || mediaType === 'carousel_album') {
    return ['impressions', 'reach', 'saved', 'likes', 'comments'];
  } else if (mediaType === 'video') {
    return ['reach', 'saved', 'video_views', 'likes', 'comments'];
  } else if (mediaType === 'reel') {
    return ['reach', 'saved', 'plays', 'likes', 'comments'];
  } else {
    return ['reach', 'saved', 'likes', 'comments'];
  }
}

// Función para obtener todas las publicaciones manejando la paginación
async function fetchAllPublications(apiUrl) {
  let allPublications = [];
  let nextPageUrl = apiUrl;

  while (nextPageUrl) {
    try {
      const response = await axios.get(nextPageUrl);
      const data = response.data;
      allPublications = allPublications.concat(data.data);

      nextPageUrl = data.paging && data.paging.next ? data.paging.next : null;
    } catch (error) {
      logger.error(`Error al obtener publicaciones: ${error.message}`);
      break;
    }
  }

  return allPublications;
}

// Función para obtener y almacenar todas las publicaciones
async function fetchAndStoreAllPosts() {
  try {
    const apiVersion = 'v21.0';

    for (const [clientName, clientConfig] of Object.entries(clients)) {
      logger.info(`Procesando datos para el cliente: ${clientName}`);

      for (const [socialNetwork, socialConfig] of Object.entries(clientConfig)) {
        logger.info(`  - Red Social: ${socialNetwork}`);

        const { access_token: accessToken, account_id: accountId } = socialConfig;

        if (!accessToken || !accountId) {
          logger.error(`    * Faltan credenciales para ${clientName} en ${socialNetwork}.`);
          continue;
        }

        let apiUrl;

        if (socialNetwork === 'facebook') {
          apiUrl = `https://graph.facebook.com/${apiVersion}/${accountId}/posts?fields=id,message,created_time,permalink_url&access_token=${accessToken}`;
        } else if (socialNetwork === 'instagram') {
          apiUrl = `https://graph.facebook.com/${apiVersion}/${accountId}/media?fields=id,caption,media_type,media_url,permalink,timestamp,username&access_token=${accessToken}`;
        } else {
          logger.warn(`    * Red social desconocida: ${socialNetwork}. Saltando.`);
          continue;
        }

        // Obtener todas las publicaciones
        const publicaciones = await fetchAllPublications(apiUrl);
        logger.info(`    * Número total de publicaciones obtenidas: ${publicaciones.length}`);

        for (const publicacion of publicaciones) {
          const publicacionId = publicacion.id;

          const pubDocRef = db.collection('proyectos')
            .doc(clientName)
            .collection('redesSociales')
            .doc(socialNetwork)
            .collection('publicaciones')
            .doc(publicacionId);

          const pubDoc = await pubDocRef.get();

          if (!pubDoc.exists) {
            logger.info(`      - Nueva publicación encontrada: ${publicacionId}. Almacenando datos básicos.`);

            // Preparar datos de la publicación
            let fechaPublicacion;
            if (socialNetwork === 'facebook') {
              fechaPublicacion = publicacion.created_time ? Timestamp.fromDate(new Date(publicacion.created_time)) : Timestamp.now();
            } else if (socialNetwork === 'instagram') {
              fechaPublicacion = publicacion.timestamp ? Timestamp.fromDate(new Date(publicacion.timestamp)) : Timestamp.now();
            }

            const datosPublicacion = {
              fechaPublicacion: fechaPublicacion,
              tipoPublicacion: socialNetwork === 'facebook' ? 'text' : publicacion.media_type || '',
              textoPublicacion: publicacion.message || publicacion.caption || '',
              enlacePublicacion: publicacion.permalink_url || publicacion.permalink || '',
              tasaEngagement: 0, // Se calculará al actualizar los insights
              detallesPublicacion: {}, // Puedes añadir más detalles si lo deseas
            };

            await pubDocRef.set(datosPublicacion);
            logger.info(`      * Publicación ${publicacionId} almacenada para ${clientName} en ${socialNetwork}.`);
          } else {
            logger.info(`      - Publicación ${publicacionId} ya existe para ${clientName} en ${socialNetwork}.`);
          }
        }
      }
    }

    logger.info('✅ Extracción y almacenamiento de publicaciones completado.');
  } catch (error) {
    logger.error('❌ Error en fetchAndStoreAllPosts:', error);
    throw error;
  }
}

// Función para actualizar los insights de las publicaciones
async function updateInsights() {
  try {
    const apiVersion = 'v21.0';

    for (const [clientName, clientConfig] of Object.entries(clients)) {
      logger.info(`Actualizando insights para el cliente: ${clientName}`);

      for (const [socialNetwork, socialConfig] of Object.entries(clientConfig)) {
        logger.info(`  - Red Social: ${socialNetwork}`);

        const { access_token: accessToken, account_id: accountId } = socialConfig;

        if (!accessToken || !accountId) {
          logger.error(`    * Faltan credenciales para ${clientName} en ${socialNetwork}.`);
          continue;
        }

        const postsCollectionRef = db.collection('proyectos')
          .doc(clientName)
          .collection('redesSociales')
          .doc(socialNetwork)
          .collection('publicaciones');

        const postsSnapshot = await postsCollectionRef.get();

        logger.info(`    * Número de publicaciones a actualizar: ${postsSnapshot.size}`);

        for (const doc of postsSnapshot.docs) {
          const publicacionId = doc.id;
          const pubDocRef = doc.ref;

          logger.info(`      - Actualizando insights para publicación: ${publicacionId}`);

          let insights = {};
          let metrics = [];

          if (socialNetwork === 'facebook') {
            metrics = ['post_impressions_unique', 'post_impressions', 'post_engaged_users'];
            const insightsUrl = `https://graph.facebook.com/${apiVersion}/${publicacionId}/insights?metric=${metrics.join(',')}&access_token=${accessToken}`;
            try {
              const insightsResponse = await axios.get(insightsUrl);
              insightsResponse.data.data.forEach((metric) => {
                insights[metric.name] = metric.values[0].value;
              });

              // Actualizar tasa de engagement
              const reach = insights['post_impressions_unique'] || 0;
              const engagedUsers = insights['post_engaged_users'] || 0;
              let tasaEngagement = 0;
              if (reach > 0) {
                tasaEngagement = (engagedUsers / reach) * 100;
              }

              // Almacenar insights en subcolección
              const insightsRef = pubDocRef.collection('insights').doc();
              await insightsRef.set({
                timestamp: Timestamp.now(),
                metrics: insights,
              });

              // Actualizar tasa de engagement en la publicación
              await pubDocRef.update({ tasaEngagement: tasaEngagement });

              logger.info(`      * Insights actualizados para publicación ${publicacionId}`);

            } catch (error) {
              logger.error(`Error al obtener insights para publicación ${publicacionId}: ${error.message}`);
              continue;
            }

          } else if (socialNetwork === 'instagram') {
            const mediaType = doc.data().tipoPublicacion.toLowerCase();

            // Obtener métricas adecuadas según el tipo de medio
            metrics = getMetricsForMediaType(mediaType);

            const insightsUrl = `https://graph.facebook.com/${apiVersion}/${publicacionId}/insights?metric=${metrics.join(',')}&access_token=${accessToken}`;

            try {
              const insightsResponse = await axios.get(insightsUrl);
              insightsResponse.data.data.forEach((metric) => {
                insights[metric.name] = metric.values[0].value;
              });

              // Calcular tasa de engagement
              const reach = insights.reach || 0;
              const interactions = (insights.likes || 0) + (insights.comments || 0) + (insights.saved || 0);
              let tasaEngagement = 0;
              if (reach > 0) {
                tasaEngagement = (interactions / reach) * 100;
              }

              // Almacenar insights en subcolección
              const insightsRef = pubDocRef.collection('insights').doc();
              await insightsRef.set({
                timestamp: Timestamp.now(),
                metrics: insights,
              });

              // Actualizar tasa de engagement en la publicación
              await pubDocRef.update({ tasaEngagement: tasaEngagement });

              logger.info(`      * Insights actualizados para publicación ${publicacionId}`);

            } catch (error) {
              logger.error(`Error al obtener insights para publicación ${publicacionId}: ${error.message}`);
              continue;
            }
          }
        }
      }
    }

    logger.info('✅ Actualización de insights completada.');
  } catch (error) {
    logger.error('❌ Error en updateInsights:', error);
    throw error;
  }
}

// Exportar funciones
exports.fetchAllPosts = onRequest(
  {
    timeoutSeconds: 540, // Incrementar el tiempo de espera si es necesario
    memory: '1GiB',    // Aumentar la memoria si es necesario
  },
  async (req, res) => {
    try {
      await fetchAndStoreAllPosts();
      logger.info('✅ Función ejecutada exitosamente: fetchAllPosts.');
      res.status(200).send('Extracción y almacenamiento de publicaciones completado.');
    } catch (error) {
      logger.error('❌ Error al ejecutar fetchAllPosts:', error);
      res.status(500).send('Error al ejecutar la función.');
    }
  }
);

exports.updateAllInsights = onSchedule(
  {
    schedule: 'every 24 hours',
    timeoutSeconds: 300,
    memory: '512MiB',
  },
  updateInsights
);
