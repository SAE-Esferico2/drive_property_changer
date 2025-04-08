import { google, drive_v3 } from 'googleapis';
import fs from 'node:fs';
import readline from 'readline';

// Google Drive API authentication scopes
const SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.metadata'
];
const TOKEN_PATH = 'token.json';
const CREDENTIALS_PATH = 'credentials.json';

interface FileInfo {
    id: string;
    name: string;
    mimeType: string;
    owners: { emailAddress: string }[];
}

async function main() {
    try {
        const auth = await authorize();
        const drive = google.drive({ version: 'v3', auth });

        // Get input from user
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        const rootFolderId = await askQuestion(rl, 'Enter the ID of the root shared folder: ');
        const targetUserEmail = await askQuestion(rl, 'Enter the email of the user whose files you want to find: ');
        rl.close();

        // Get the root folder owner
        const rootFolder = await drive.files.get({
            fileId: rootFolderId,
            fields: 'owners'
        });

        if (!rootFolder.data.owners || rootFolder.data.owners.length === 0) {
            throw new Error('Could not determine the root folder owner');
        }

        const rootOwnerEmail = rootFolder.data.owners[0].emailAddress;
        console.log(`Root folder owner: ${rootOwnerEmail}`);
        console.log(`Searching for files owned by: ${targetUserEmail}`);

        // Process the root folder recursively
        await processFolder(drive, rootFolderId, targetUserEmail, rootOwnerEmail);

        console.log('Process completed successfully!');
    } catch (error) {
        console.error('Error:', error);
    }
}

async function askQuestion(rl: readline.Interface, question: string): Promise<string> {
    return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer));
    });
}

async function processFolder(
    drive: drive_v3.Drive,
    folderId: string,
    targetUserEmail: string,
    rootOwnerEmail: string
) {
    console.log(`Processing folder with ID: ${folderId}`);

    let pageToken: string | undefined = undefined;

    do {
        // List all files and folders in the current folder
        const response = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'nextPageToken, files(id, name, mimeType, owners)',
            pageToken: pageToken,
            pageSize: 1000
        });

        const files = response.data.files as FileInfo[];
        pageToken = response.data.nextPageToken;

        // Process each file/folder
        for (const file of files) {
            const isOwnedByTarget = file.owners.some(owner => owner.emailAddress === targetUserEmail);

            if (isOwnedByTarget) {
                console.log(`Found item owned by target user: ${file.name} (ID: ${file.id})`);

                // Handle the file or folder
                if (file.mimeType === 'application/vnd.google-apps.folder') {
                    // For folders, create a new folder with same name
                    const newFolder = await drive.files.create({
                        requestBody: {
                            name: file.name,
                            mimeType: 'application/vnd.google-apps.folder',
                            parents: [folderId]
                        },
                        fields: 'id,name'
                    });

                    console.log(`Created new folder: ${newFolder.data.name} (ID: ${newFolder.data.id})`);

                    // Copy contents from old folder to new folder
                    await copyFolderContents(drive, file.id, newFolder.data.id, targetUserEmail, rootOwnerEmail);
                } else {
                    // For files, create a copy
                    await copyFile(drive, file.id, folderId, file.name);
                }
            }

            // If it's a folder (regardless of ownership), process recursively
            if (file.mimeType === 'application/vnd.google-apps.folder') {
                await processFolder(drive, file.id, targetUserEmail, rootOwnerEmail);
            }
        }
    } while (pageToken);
}

async function copyFolderContents(
    drive: drive_v3.Drive,
    sourceFolderId: string,
    destFolderId: string,
    targetUserEmail: string,
    rootOwnerEmail: string
) {
    let pageToken: string | undefined = undefined;

    do {
        const response = await drive.files.list({
            q: `'${sourceFolderId}' in parents and trashed = false`,
            fields: 'nextPageToken, files(id, name, mimeType, owners)',
            pageToken: pageToken
        });

        const files = response.data.files as FileInfo[];
        pageToken = response.data.nextPageToken;

        for (const file of files) {
            if (file.mimeType === 'application/vnd.google-apps.folder') {
                // Create a new subfolder
                const newFolder = await drive.files.create({
                    requestBody: {
                        name: file.name,
                        mimeType: 'application/vnd.google-apps.folder',
                        parents: [destFolderId]
                    },
                    fields: 'id,name'
                });

                await copyFolderContents(drive, file.id, newFolder.data.id, targetUserEmail, rootOwnerEmail);
            } else {
                // Copy the file to the new location
                await copyFile(drive, file.id, destFolderId, file.name);
            }
        }
    } while (pageToken);
}

async function copyFile(drive: drive_v3.Drive, fileId: string, parentId: string, fileName: string) {
    try {
        const newFile = await drive.files.copy({
            fileId: fileId,
            requestBody: {
                name: fileName,
                parents: [parentId]
            },
            fields: 'id,name'
        });

        console.log(`Copied file: ${newFile.data.name} (ID: ${newFile.data.id})`);
    } catch (error) {
        console.error(`Error copying file ${fileName}:`, error);
    }
}

async function authorize() {
    try {
        const content = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
        const credentials = JSON.parse(content);
        const { client_secret, client_id, redirect_uris } = credentials.installed;
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

        try {
            // Check if we have previously stored a token
            const token = fs.readFileSync(TOKEN_PATH, 'utf8');
            oAuth2Client.setCredentials(JSON.parse(token));
            return oAuth2Client;
        } catch (err) {
            return getAccessToken(oAuth2Client);
        }
    } catch (err) {
        console.error('Error loading client secret file:', err);
        throw err;
    }
}

async function getAccessToken(oAuth2Client: any) {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
    });

    console.log('Authorize this app by visiting this url:', authUrl);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const code = await askQuestion(rl, 'Enter the code from that page here: ');
    rl.close();

    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    // Store the token to disk for later program executions
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log('Token stored to', TOKEN_PATH);

    return oAuth2Client;
}

// Run the program
main();