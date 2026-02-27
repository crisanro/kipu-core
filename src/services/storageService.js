const Minio = require('minio');
require('dotenv').config();

console.log("[Storage] Inicializando MinIO con endpoint:", process.env.MINIO_ENDPOINT);
const minioClient = new Minio.Client({
    endPoint: process.env.MINIO_ENDPOINT || '',
    port: parseInt(process.env.MINIO_PORT) || 9000,
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ROOT_USER,
    secretKey: process.env.MINIO_ROOT_PASSWORD
});


/**
 * Sube un buffer a un bucket de MinIO
 */
async function uploadFile(bucket, fileName, buffer, contentType = 'application/octet-stream') {
    try {
        // Asegurar que el bucket existe
        const exists = await minioClient.bucketExists(bucket);
        if (!exists) {
            await minioClient.makeBucket(bucket);
        }

        await minioClient.putObject(bucket, fileName, buffer, {
            'Content-Type': contentType
        });

        return `${bucket}/${fileName}`;
    } catch (err) {
        console.error("Error subiendo archivo a MinIO:", err);
        throw err;
    }
}

/**
 * Obtiene un buffer desde MinIO
 */
async function downloadFile(bucket, fileName) {
    try {
        const dataStream = await minioClient.getObject(bucket, fileName);
        return new Promise((resolve, reject) => {
            let chunks = [];
            dataStream.on('data', chunk => chunks.push(chunk));
            dataStream.on('end', () => resolve(Buffer.concat(chunks)));
            dataStream.on('error', err => reject(err));
        });
    } catch (err) {
        console.error("Error descargando archivo de MinIO:", err);
        throw err;
    }
}

/**
 * Genera una URL firmada (temporal) para acceso desde el cliente
 */
async function getSignedUrl(bucket, fileName, expires = 3600) {
    try {
        return await minioClient.presignedGetObject(bucket, fileName, expires);
    } catch (err) {
        console.error("Error generando URL firmada:", err);
        throw err;
    }
}

/**
 * Elimina un archivo de MinIO
 */
async function deleteFile(bucket, fileName) {
    try {
        await minioClient.removeObject(bucket, fileName);
        return true;
    } catch (err) {
        console.error("Error eliminando archivo de MinIO:", err);
        throw err;
    }
}

module.exports = { uploadFile, downloadFile, getSignedUrl, deleteFile, minioClient };
