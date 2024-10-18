/**
 * Importación de módulos necesarios:
 * - onRequest: Para crear funciones HTTP (útil para pruebas).
 * - onSchedule: Para funciones programadas.
 * - logger: Para registrar información y errores.
 */
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");

/**
 * Importación de Firebase Admin SDK para interactuar con Firestore
 */
const admin = require("firebase-admin");

/**
 * Importación de axios para hacer solicitudes HTTP a las APIs de Meta
 */
const axios = require("axios");

/**
 * Inicializar la aplicación de Firebase Admin
 */
admin.initializeApp();

/**
 * Obtener referencia a Firestore
 */
const db = admin.firestore();

/**
 * Acceder a las variables de configuración establecidas previamente.
 * Estas variables contienen los tokens y IDs necesarios para cada cliente y red social.
 */
const clients = JSON.parse(process.env.CLIENTES);
console.log(clients);

/**
 * Función programada que se ejecuta cada 24 horas para obtener publicaciones e insights
 * de Facebook e Instagram para cada cliente.
 */
exports.fetchSocialMediaData = onSchedule('every 24 hours', async () => {
    try {
        // Iterar sobre cada cliente definido en la configuración
        for (const [clientName, clientConfig] of Object.entries(clients)) {
            logger.info(`Procesando datos para el cliente: ${clientName}`);

            // Iterar sobre cada red social del cliente
            for (const [socialNetwork, socialConfig] of Object.entries(clientConfig)) {
                logger.info(`  - Red Social: ${socialNetwork}`);

                const { access_token: accessToken, account_id: accountId } = socialConfig;

                // Validar que existan las credenciales necesarias
                if (!accessToken || !accountId) {
                    logger.error(`    * Faltan credenciales para ${clientName} en ${socialNetwork}.`);
                    continue;
                }

                // Definir la URL de la API y las métricas según la red social
                let apiUrl;
                let metrics = [];

                if (socialNetwork === 'facebook') {
                    apiUrl = `https://graph.facebook.com/${accountId}/posts?access_token=${accessToken}`;
                    metrics = ['post_impressions', 'post_engaged_users'];
                } else if (socialNetwork === 'instagram') {
                    apiUrl = `https://graph.instagram.com/${accountId}/media?fields=id,caption,media_type,media_url,permalink,timestamp,username&access_token=${accessToken}`;
                    metrics = ['impressions', 'reach', 'engagement', 'saved', 'video_views'];
                } else {
                    logger.warn(`    * Red social desconocida: ${socialNetwork}. Saltando.`);
                    continue;
                }

                try {
                    // Hacer la solicitud a la API de Meta
                    const response = await axios.get(apiUrl);
                    const publicaciones = response.data.data;

                    logger.info(`    * Número de publicaciones obtenidas: ${publicaciones.length}`);

                    // Iterar sobre cada publicación obtenida
                    for (const publicacion of publicaciones) {
                        const publicacionId = publicacion.id;

                        // Definir la ruta en Firestore para almacenar la publicación
                        const pubDocRef = db.collection('proyectos')
                            .doc(clientName)
                            .collection('redesSociales')
                            .doc(socialNetwork)
                            .collection('publicaciones')
                            .doc(publicacionId);

                        // Verificar si la publicación ya existe en Firestore
                        const pubDoc = await pubDocRef.get();

                        if (!pubDoc.exists) {
                            logger.info(`      - Nueva publicación encontrada: ${publicacionId}. Obteniendo insights.`);

                            let insights = {};

                            // Obtener insights de la publicación según la red social
                            if (socialNetwork === 'facebook') {
                                const insightsUrl = `https://graph.facebook.com/${publicacionId}/insights?metric=${metrics.join(',')}&access_token=${accessToken}`;
                                const insightsResponse = await axios.get(insightsUrl);
                                insightsResponse.data.data.forEach((metric) => {
                                    insights[metric.name] = metric.values[0].value;
                                });
                            } else if (socialNetwork === 'instagram') {
                                const insightsUrl = `https://graph.instagram.com/${publicacionId}/insights?metric=${metrics.join(',')}&access_token=${accessToken}`;
                                const insightsResponse = await axios.get(insightsUrl);
                                insightsResponse.data.data.forEach((metric) => {
                                    insights[metric.name] = metric.values[0].value;
                                });
                            }

                            // Formatear los datos de la publicación para Firestore
                            const datosPublicacion = {
                                fechaPublicacion: admin.firestore.Timestamp.fromDate(new Date(publicacion.timestamp)),
                                tipoPublicacion: publicacion.media_type || 'text',
                                textoPublicacion: publicacion.caption || '',
                                enlacePublicacion: publicacion.permalink || '',
                                tasaEngagement: insights.engagement || insights.post_engaged_users || 0,
                                detallesPublicacion: {
                                    videoViews: insights.video_views || 0,
                                    duration: 60,
                                    thumbnailUrl: publicacion.media_url || ''
                                },
                                metrics: {
                                    impressions: insights.impressions || insights.post_impressions || 0,
                                    reach: insights.reach || 0,
                                    totalInteractions: insights.engagement || insights.post_engaged_users || 0,
                                    saved: insights.saved || 0,
                                    videoViews: insights.video_views || 0
                                }
                            };

                            // Insertar la publicación en Firestore
                            await pubDocRef.set(datosPublicacion);
                            logger.info(`      * Publicación ${publicacionId} agregada para ${clientName} en ${socialNetwork}.`);
                        } else {
                            logger.info(`      - Publicación ${publicacionId} ya existe para ${clientName} en ${socialNetwork}.`);
                        }
                    }
                } catch (apiError) {
                    logger.error(`    * Error al obtener datos de ${socialNetwork} para ${clientName}: ${apiError.message}`);
                    continue;
                }
            }
        }

        logger.info('✅ Migración completada para todos los clientes y redes sociales.');
        return null;
    } catch (error) {
        logger.error('❌ Error en la función:', error);
    }
});

/**
 * Función HTTP temporal para probar fetchSocialMediaData.
 * No la uses en producción; elimínala después de las pruebas.
 */
exports.testFetchSocialMediaData = onRequest(async (req, res) => {
    try {
        await exports.fetchSocialMediaData();
        logger.info('✅ Función ejecutada exitosamente mediante testFetchSocialMediaData.');
        res.status(200).send('Función ejecutada exitosamente.');
    } catch (error) {
        logger.error('❌ Error al ejecutar testFetchSocialMediaData:', error);
        res.status(500).send('Error al ejecutar la función.');
    }
});
