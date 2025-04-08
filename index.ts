import fs from 'node:fs/promises';
import path from 'path';
import process from 'process';
import { google } from 'googleapis';

const SERVICE_ACCOUNT_JSON_PATH = process.env.SERVICE_ACCOUNT_JSON_PATH;

if (!SERVICE_ACCOUNT_JSON_PATH) {
    console.error('La variable de entorno SERVICE_ACCOUNT_JSON_PATH no está definida.');
    process.exit(1);
}

// Si modificas estos permisos, asegúrate de que tu cuenta de servicio tenga acceso
const SCOPES = ['https://www.googleapis.com/auth/drive.metadata.readonly'];

/**
 * Autoriza usando credenciales de cuenta de servicio.
 */
async function authorize() {
    try {
        const content = await fs.readFile(SERVICE_ACCOUNT_JSON_PATH!, 'utf8');
        const serviceAccountKey = JSON.parse(content.toString());

        const auth = new google.auth.GoogleAuth({
            credentials: serviceAccountKey,
            scopes: SCOPES
        });

        return auth.getClient();
    } catch (err) {
        console.error('Error al autorizar con la cuenta de servicio:', err);
        throw err;
    }
}

/**
 * Lists the names and IDs of up to 10 files.
 * @param {OAuth2Client} authClient An authorized OAuth2 client.
 */
async function listFiles(authClient) {
    const drive = google.drive({ version: 'v3', auth: authClient });
    const res = await drive.files.list({
        pageSize: 10,
        fields: 'nextPageToken, files(id, name)',
    });
    const files = res.data.files;
    if (files?.length === 0) {
        console.log('No files found.');
        return;
    }

    console.log('Files:');
    files?.map((file) => {
        console.log(`${file.name} (${file.id})`);
    });
}

authorize().then(listFiles).catch(console.error);