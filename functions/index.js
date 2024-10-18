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

// Función principal
async function fetchSocialMediaDataHandler() {
  try {
    const apiVersion = 'v17.0';

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
          apiUrl = `https://graph.facebook.com/${apiVersion}/${accountId}/posts?fields=id,message,created_time,permalink_url,likes.summary(true),comments.summary(true),shares&access_token=${accessToken}`;
          logger.log(`La apiUrl es: ${apiUrl}.`);
        } else if (socialNetwork === 'instagram') {
          apiUrl = `https://graph.facebook.com/${apiVersion}/${accountId}/media?fields=id,caption,media_type,media_url,permalink,timestamp,username&access_token=${accessToken}`;
        } else {
          logger.warn(`    * Red social desconocida: ${socialNetwork}. Saltando.`);
          continue;
        }

        try {
          const response = await axios.get(apiUrl);
          const publicaciones = response.data.data;

          logger.info(`    * Número de publicaciones obtenidas: ${publicaciones.length}`);

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
              logger.info(`      - Nueva publicación encontrada: ${publicacionId}. Obteniendo insights.`);

              let insights = {};
              let metrics = [];

              if (socialNetwork === 'facebook') {
                metrics = ['post_impressions_unique', 'post_impressions'];
                const insightsUrl = `https://graph.facebook.com/${apiVersion}/${publicacionId}/insights?metric=${metrics.join(',')}&access_token=${accessToken}`;
                const insightsResponse = await axios.get(insightsUrl);
                insightsResponse.data.data.forEach((metric) => {
                  insights[metric.name] = metric.values[0].value;
                });

                const likes = publicacion.likes ? publicacion.likes.summary.total_count : 0;
                const comments = publicacion.comments ? publicacion.comments.summary.total_count : 0;
                const shares = publicacion.shares ? publicacion.shares.count : 0;
                const reach = insights['post_impressions_unique'] || 0;

                let tasaEngagement = 0;
                if (reach > 0) {
                  tasaEngagement = ((likes + comments + shares) / reach) * 100;
                }

                // Verificar y asignar fecha de publicación
                const fechaPublicacionValue = publicacion.created_time;
                let fechaPublicacion;
                if (fechaPublicacionValue) {
                  fechaPublicacion = Timestamp.fromDate(new Date(fechaPublicacionValue));
                } else {
                  logger.warn(`      * No se encontró fecha de publicación para ${publicacionId}. Usando fecha actual.`);
                  fechaPublicacion = Timestamp.fromDate(new Date());
                }

                const datosPublicacion = {
                  fechaPublicacion: fechaPublicacion,
                  tipoPublicacion: 'text',
                  textoPublicacion: publicacion.message || '',
                  enlacePublicacion: publicacion.permalink_url || '',
                  tasaEngagement: tasaEngagement,
                  detallesPublicacion: {
                    videoViews: 0,
                    duration: 0,
                    thumbnailUrl: ''
                  },
                  metrics: {
                    impressions: insights['post_impressions'] || 0,
                    reach: reach,
                    totalInteractions: likes + comments + shares,
                    saved: 0,
                    videoViews: 0
                  }
                };

                await pubDocRef.set(datosPublicacion);
                logger.info(`      * Publicación ${publicacionId} agregada para ${clientName} en ${socialNetwork}.`);

              } else if (socialNetwork === 'instagram') {
                const mediaType = publicacion.media_type.toLowerCase().trim();

                // Obtener métricas adecuadas según el tipo de medio
                metrics = getMetricsForMediaType(mediaType);

                const insightsUrl = `https://graph.facebook.com/${apiVersion}/${publicacionId}/insights?metric=${metrics.join(',')}&access_token=${accessToken}`;
                logger.log(`La insightsUrl es: ${insightsUrl}.`);

                // Manejar errores al obtener insights
                try {
                  const insightsResponse = await axios.get(insightsUrl);
                  insightsResponse.data.data.forEach((metric) => {
                    insights[metric.name] = metric.values[0].value;
                  });
                } catch (error) {
                  logger.error(`Error al obtener insights para la publicación ${publicacionId}: ${error.message}`);
                  if (error.response && error.response.data) {
                    logger.error(`Detalles del error: ${JSON.stringify(error.response.data)}`);
                  }
                  // Continuar con la siguiente publicación
                  continue;
                }

                const likes = insights.likes || 0;
                const comments = insights.comments || 0;
                const saved = insights.saved || 0;
                const reach = insights.reach || 0;

                let totalInteractions = likes + comments + saved;
                let tasaEngagement = 0;
                if (reach > 0) {
                  tasaEngagement = (totalInteractions / reach) * 100;
                }

                // Verificar y asignar fecha de publicación
                const fechaPublicacionValue = publicacion.timestamp;
                let fechaPublicacion;
                if (fechaPublicacionValue) {
                  fechaPublicacion = Timestamp.fromDate(new Date(fechaPublicacionValue));
                } else {
                  logger.warn(`      * No se encontró fecha de publicación para ${publicacionId}. Usando fecha actual.`);
                  fechaPublicacion = Timestamp.fromDate(new Date());
                }

                const datosPublicacion = {
                  fechaPublicacion: fechaPublicacion,
                  tipoPublicacion: publicacion.media_type || '',
                  textoPublicacion: publicacion.caption || '',
                  enlacePublicacion: publicacion.permalink || '',
                  tasaEngagement: tasaEngagement,
                  detallesPublicacion: {
                    videoViews: insights.plays || insights['video_views'] || 0,
                    duration: 0,
                    thumbnailUrl: publicacion.media_url || ''
                  },
                  metrics: {
                    impressions: insights.impressions || 0,
                    reach: reach,
                    totalInteractions: totalInteractions,
                    saved: saved,
                    videoViews: insights.plays || insights['video_views'] || 0
                  }
                };

                await pubDocRef.set(datosPublicacion);
                logger.info(`      * Publicación ${publicacionId} agregada para ${clientName} en ${socialNetwork}.`);
              }
            } else {
              logger.info(`      - Publicación ${publicacionId} ya existe para ${clientName} en ${socialNetwork}.`);
            }
          }
        } catch (apiError) {
          logger.error(`    * Error al obtener datos de ${socialNetwork} para ${clientName}: ${apiError.message}`);

          if (apiError.response && apiError.response.data) {
            logger.error(`    * Detalles del error de la API: ${JSON.stringify(apiError.response.data)}`);
          }
          continue;
        }
      }
    }

    logger.info('✅ Migración completada para todos los clientes y redes sociales.');
  } catch (error) {
    logger.error('❌ Error en fetchSocialMediaDataHandler:', error);
    throw error;
  }
}

// Exportar funciones
exports.fetchSocialMediaData = onSchedule(
  {
    schedule: 'every 24 hours',
    timeoutSeconds: 300, // Incrementar el tiempo de espera a 5 minutos
    memory: '512MiB',    // Opcional: aumentar la memoria si es necesario
  },
  fetchSocialMediaDataHandler
);

exports.testFetchSocialMediaData = onRequest(
  {
    timeoutSeconds: 300, // Incrementar el tiempo de espera a 5 minutos
    memory: '512MiB',    // Opcional: aumentar la memoria si es necesario
  },
  async (req, res) => {
    try {
      await fetchSocialMediaDataHandler();
      logger.info('✅ Función ejecutada exitosamente mediante testFetchSocialMediaData.');
      res.status(200).send('Función ejecutada exitosamente.');
    } catch (error) {
      logger.error('❌ Error al ejecutar testFetchSocialMediaData:', error);
      res.status(500).send('Error al ejecutar la función.');
    }
  }
);
