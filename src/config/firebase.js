const admin = require('firebase-admin');
require('dotenv').config();

// El reemplazo de los saltos de línea en la clave privada es vital para Docker/VPS
const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: privateKey,
  }),
});

module.exports = admin;