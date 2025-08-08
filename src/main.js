// src/main.js (Final Corrected Version)
const { app, BrowserWindow, ipcMain, dialog, Menu, MenuItem, shell } = require('electron');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const Store = require('electron-store');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { DOMParser } = require('xmldom');

let db;
const store = new Store();
let mainWindow;

// --- Helper functions for database queries ---
const dbRun = (query, params) => new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
    });
});
const dbGet = (query, params) => new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => (err ? reject(err) : resolve(row)));
});
const dbAll = (query, params) => new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

function showDbError(error) {
    console.error("Database Error:", error);
    dialog.showErrorBox("Database Error", "An error occurred while interacting with the workspace. Please try again.\n\nDetails: " + error.message);
}

function addWorkspaceToRecents(filePath) {
    const recents = store.get('recentWorkspaces', []);
    const newRecents = [filePath, ...recents.filter(p => p !== filePath)];
    store.set('recentWorkspaces', newRecents.slice(0, 5));
}

async function handleOpenWorkspace(window, filePath) {
    try {
        let finalPath = filePath;
        if (!finalPath) {
            const { canceled, filePaths } = await dialog.showOpenDialog(window, {
                properties: ['openFile'],
                filters: [{ name: 'SQLite Databases', extensions: ['sqlite', 'db'] }]
            });
            if (canceled || filePaths.length === 0) return false;
            finalPath = filePaths[0];
        }
        db = new sqlite3.Database(finalPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
            if (err) console.error(err.message);
        });
        addWorkspaceToRecents(finalPath);
        await dbRun('CREATE TABLE IF NOT EXISTS workflows (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
        await dbRun('CREATE TABLE IF NOT EXISTS datasources (id INTEGER PRIMARY KEY, name TEXT UNIQUE, type TEXT, alias TEXT)');
        await dbRun('CREATE TABLE IF NOT EXISTS connections (id INTEGER PRIMARY KEY, workflowId INTEGER, dsId INTEGER, direction TEXT, query TEXT)');
        return true;
    } catch (error) {
        showDbError(error);
        return false;
    }
}

async function handleCreateWorkspace(window) {
    try {
        const { canceled, filePath } = await dialog.showSaveDialog(window, {
            title: 'Create New Workspace',
            defaultPath: 'alteryx-lineage.sqlite',
            filters: [{ name: 'SQLite Databases', extensions: ['sqlite', 'db'] }]
        });
        if (canceled || !filePath) return false;
        db = new sqlite3.Database(filePath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
            if (err) console.error(err.message);
        });
        addWorkspaceToRecents(filePath);
        await dbRun('CREATE TABLE IF NOT EXISTS workflows (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
        await dbRun('CREATE TABLE IF NOT EXISTS datasources (id INTEGER PRIMARY KEY, name TEXT UNIQUE, type TEXT, alias TEXT)');
        await dbRun('CREATE TABLE IF NOT EXISTS connections (id INTEGER PRIMARY KEY, workflowId INTEGER, dsId INTEGER, direction TEXT, query TEXT)');
        return true;
    } catch (error) {
        showDbError(error);
        return false;
    }
}

// --- SHARED WORKFLOW PARSING & SAVING LOGIC ---
function parseWorkflowFromString(xmlString, fileName) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "text/xml");
    const nodes = xmlDoc.getElementsByTagName('Node');
    const results = { name: fileName, inputs: [], outputs: [] };
    for (const node of nodes) {
        let path, type, value;
        const annotationNode = node.querySelector('Annotation');
        const annotationText = annotationNode?.querySelector('AnnotationText')?.textContent || annotationNode?.querySelector('DefaultAnnotationText')?.textContent || '';
        const lineageMatch = annotationText.match(/--- lineage ---([\s\S]*?)---/);
        if (lineageMatch) {
            const content = lineageMatch[1];
            let currentSection = null;
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.startsWith('inputs:')) { currentSection = 'inputs'; continue; }
                if (line.startsWith('outputs:')) { currentSection = 'outputs'; continue; }
                if (line.startsWith('- type:')) {
                    const typeMatch = line.match(/- type:\s*(\w+)/);
                    if (typeMatch && i + 1 < lines.length) {
                        const nextLine = lines[i + 1].trim();
                        const pathMatch = nextLine.match(/path:\s*(.*)/);
                        if (pathMatch) {
                            const targetArray = currentSection === 'inputs' ? results.inputs : results.outputs;
                            if (targetArray) {
                                targetArray.push({ type: typeMatch[1], value: { connection: pathMatch[1], query: '' } });
                            }
                            i++;
                        }
                    }
                }
            }
            continue;
        }
        const plugin = node.querySelector('GuiSettings')?.getAttribute('Plugin');
        if (!plugin) continue;
        if (plugin.includes('Input') || plugin.includes('Output')) {
            const fileElement = node.querySelector('Properties > Configuration > File');
            if (fileElement) {
                path = fileElement.textContent;
                const isDb = path.startsWith('odbc:') || path.startsWith('aka:');
                type = isDb ? 'Database' : 'File';
                const queryElement = node.querySelector('Properties > Configuration > Query');
                const queryText = queryElement ? queryElement.textContent.trim() : '';
                value = {
                    connection: isDb && path.includes('|||') ? path.split('|||')[0] : path,
                    query: queryText || (isDb && path.includes('|||') ? (path.split('|||')[1] || '') : '')
                };
                const targetArray = plugin.includes('Input') ? results.inputs : results.outputs;
                targetArray.push({ type, value });
            }
        }
        if (plugin.includes('DynamicInput')) {
            const templateFileElement = node.querySelector('Properties > Configuration > InputConfiguration > Configuration > File');
            if (templateFileElement) {
                path = templateFileElement.textContent;
                type = 'File';
                value = { connection: `(Dynamic) ${path}`, query: '' };
                results.inputs.push({ type, value });
            }
        }
        const engineSettings = node.querySelector('EngineSettings');
        if (engineSettings && engineSettings.getAttribute('Macro')?.includes('Input Data Selector.yxmc')) {
            const valueElement = node.querySelector('Properties > Configuration > Value');
            if (valueElement) {
                path = valueElement.textContent;
                type = 'File';
                value = { connection: path, query: '' };
                results.inputs.push({ type, value });
            }
        }
    }
    return results;
}

const getUniqueConnections = (items) => {
    const uniqueMap = new Map();
    for (const item of items) {
        const key = `${item.type}|||${item.value.connection}`;
        if (!uniqueMap.has(key)) {
            uniqueMap.set(key, item);
        }
    }
    return Array.from(uniqueMap.values());
};

async function processAndSaveWorkflow(workflowData) {
    const allConnections = [...workflowData.inputs, ...workflowData.outputs];
    for (const item of allConnections) {
        if (item.value && item.value.connection) {
            item.value.connection = item.value.connection.toLowerCase();
        }
    }
    try {
        let workflow = await dbGet('SELECT id FROM workflows WHERE name = ?', [workflowData.name]);
        if (workflow) {
            await dbRun('DELETE FROM connections WHERE workflowId = ?', [workflow.id]);
        } else {
            const result = await dbRun('INSERT INTO workflows (name) VALUES (?)', [workflowData.name]);
            workflow = { id: result.lastID };
        }
        const processConnections = async (items, direction) => {
            const uniqueItems = getUniqueConnections(items);
            for (const item of uniqueItems) {
                let datasource = await dbGet('SELECT id FROM datasources WHERE name = ?', [item.value.connection]);
                if (!datasource) {
                    const result = await dbRun('INSERT INTO datasources (name, type, alias) VALUES (?, ?, ?)', [item.value.connection, item.type, '']);
                    datasource = { id: result.lastID };
                }
                await dbRun('INSERT INTO connections (workflowId, dsId, direction, query) VALUES (?, ?, ?, ?)', [workflow.id, datasource.id, direction, item.value.query]);
            }
        };
        await processConnections(workflowData.inputs, 'input');
        await processConnections(workflowData.outputs, 'output');
        return { success: true };
    } catch (error) {
        showDbError(error);
        return { success: false, error: error.message };
    }
}

// --- Main Window Creation and Menu Setup ---
function createWindow() {
    const splashWindow = new BrowserWindow({
        width: 640,
        height: 448,
        backgroundColor: '#1f2937',
        transparent: true,
        frame: false,
        alwaysOnTop: true
    });
    splashWindow.loadFile(path.join(__dirname, 'splash.html'));

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "Alteryx Lineage Visualizer",
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    const menuTemplate = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'Create New Workspace',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => mainWindow && handleCreateWorkspace(mainWindow)
                },
                {
                    label: 'Open Workspace...',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => mainWindow && handleOpenWorkspace(mainWindow, null)
                },
                {
                    label: 'Open Recent',
                    submenu: [] // This will be populated dynamically
                },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'Edit',
            submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
        },
        {
            label: 'View',
            submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }]
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'How to Use this Tool',
                    click: async () => {
                        await shell.openExternal('https://github.com/wrjones104/alteryx-lineage-desktop/blob/main/USAGE.md');
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    const mainWindowReady = new Promise(resolve => mainWindow.once('ready-to-show', resolve));
    const minSplashTime = new Promise(resolve => {
        const delay = 3000;
        setTimeout(resolve, delay);
    });

    Promise.all([mainWindowReady, minSplashTime]).then(() => {
        splashWindow.destroy();
        mainWindow.show();

        const recentWorkspaces = store.get('recentWorkspaces', []);
        const recentMenu = Menu.getApplicationMenu().items.find(item => item.label === 'File').submenu.items.find(item => item.label === 'Open Recent');
        if (recentMenu) {
            recentMenu.submenu.clear();
            recentWorkspaces.forEach(filePath => {
                recentMenu.submenu.append(new MenuItem({
                    label: filePath.split('\\').pop().split('/').pop().replace('.sqlite', ''),
                    click: () => mainWindow.webContents.send('open-recent-file', filePath)
                }));
            });
        }
    });
}

// --- App Lifecycle and IPC Handlers ---
app.whenReady().then(() => {
    ipcMain.handle('open-db-file', (event, filePath) => handleOpenWorkspace(BrowserWindow.fromWebContents(event.sender), filePath));
    ipcMain.handle('create-db-file', (event) => handleCreateWorkspace(BrowserWindow.fromWebContents(event.sender)));
    ipcMain.handle('get-recent-workspaces', () => store.get('recentWorkspaces', []));
    ipcMain.handle('load-all-data', async () => ({
        workflows: await dbAll('SELECT * FROM workflows'),
        datasources: await dbAll('SELECT * FROM datasources'),
        connections: await dbAll('SELECT * FROM connections'),
    }));
    ipcMain.handle('update-alias', async (event, { dsId, newAlias }) => dbRun('UPDATE datasources SET alias = ? WHERE id = ?', [newAlias, dsId]));
    ipcMain.handle('save-workflow', (event, workflowData) => processAndSaveWorkflow(workflowData));
    ipcMain.handle('get-server-credentials', () => store.get('serverCredentials'));
    ipcMain.handle('save-server-credentials', (event, credentials) => store.set('serverCredentials', credentials));

    // Handler to just fetch the workflow list
    ipcMain.handle('fetch-server-workflows', async (event, { baseUrl, clientId, clientSecret }) => {
        try {
            const authUrl = `${baseUrl}/webapi/oauth2/token`;
            const payload = { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret };
            const authResponse = await axios.post(authUrl, payload, { httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }) });
            const accessToken = authResponse.data.access_token;

            const workflowsUrl = `${baseUrl}/webapi/v3/workflows?view=Default`;
            const headers = { Authorization: `Bearer ${accessToken}` };
            const workflowsResponse = await axios.get(workflowsUrl, { headers, httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }) });
            
            return { success: true, data: workflowsResponse.data.map(wf => ({ id: wf.id, name: wf.name })) };
        } catch (error) {
            const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
            return { success: false, error: `Failed to fetch workflows: ${errorMessage}` };
        }
    });
    
    // Handler to process a specific list of workflows
    ipcMain.handle('sync-with-server', async (event, { baseUrl, clientId, clientSecret, selectedWorkflows }) => {
        const webContents = event.sender;
        try {
            const authUrl = `${baseUrl}/webapi/oauth2/token`;
            const payload = { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret };
            const authResponse = await axios.post(authUrl, payload, { httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }) });
            const accessToken = authResponse.data.access_token;
            const headers = { Authorization: `Bearer ${accessToken}` };

            const total = selectedWorkflows.length;
            for (let i = 0; i < total; i++) {
                const wf = selectedWorkflows[i];
                webContents.send('sync-progress', { message: `Processing ${i + 1}/${total}: ${wf.name}` });
                const downloadUrl = `${baseUrl}/webapi/v3/workflows/${wf.id}/package`;
                const packageResponse = await axios.get(downloadUrl, { headers, responseType: 'arraybuffer', httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }) });
                
                const zip = new AdmZip(packageResponse.data);
                const yxmdEntry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.yxmd') || e.entryName.toLowerCase().endsWith('.yxmc'));

                if (yxmdEntry) {
                    const xmlContent = yxmdEntry.getData().toString('utf-8');
                    const parsedData = parseWorkflowFromString(xmlContent, wf.name);
                    await processAndSaveWorkflow(parsedData);
                }
            }
            return { success: true, message: `Successfully synced ${total} workflows.` };
        } catch (error) {
            const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
            return { success: false, error: `Server sync failed: ${errorMessage}` };
        }
    });

    ipcMain.handle('delete-workflow', async (event, workflowId) => {
        if (!db) {
            showDbError({ message: "Database not open." });
            return { success: false, error: "Database not open." };
        }
        try {
            await dbRun('BEGIN TRANSACTION');

            const connectedDs = await dbAll('SELECT DISTINCT dsId FROM connections WHERE workflowId = ?', [workflowId]);
            const dsIds = connectedDs.map(r => r.dsId);

            await dbRun('DELETE FROM connections WHERE workflowId = ?', [workflowId]);
            await dbRun('DELETE FROM workflows WHERE id = ?', [workflowId]);

            for (const dsId of dsIds) {
                const isConnected = await dbGet('SELECT 1 FROM connections WHERE dsId = ? LIMIT 1', [dsId]);
                if (!isConnected) {
                    await dbRun('DELETE FROM datasources WHERE id = ?', [dsId]);
                }
            }

            await dbRun('COMMIT');
            return { success: true };
        } catch (error) {
            await dbRun('ROLLBACK');
            showDbError(error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('calculate-criticality', async () => {
        try {
            const workflows = await dbAll('SELECT * FROM workflows');
            const connections = await dbAll('SELECT * FROM connections');
    
            const dsToWorkflows = new Map(); 
            const workflowToDs = new Map(); 
    
            for (const conn of connections) {
                if (conn.direction === 'input') {
                    if (!dsToWorkflows.has(conn.dsId)) dsToWorkflows.set(conn.dsId, []);
                    dsToWorkflows.get(conn.dsId).push(conn.workflowId);
                } else { 
                    if (!workflowToDs.has(conn.workflowId)) workflowToDs.set(conn.workflowId, []);
                    workflowToDs.get(conn.workflowId).push(conn.dsId);
                }
            }
    
            const results = [];
            for (const wf of workflows) {
                const queue = [];
                const visited = new Set();
                let score = 0;
    
                const directOutputs = workflowToDs.get(wf.id) || [];
                for (const dsId of directOutputs) {
                    const nodeId = `ds-${dsId}`;
                    if (!visited.has(nodeId)) {
                        queue.push({ id: nodeId, type: 'datasource' });
                        visited.add(nodeId);
                    }
                }
                
                while (queue.length > 0) {
                    const current = queue.shift();
                    score++;
    
                    const currentId = parseInt(current.id.split('-')[1]);
    
                    if (current.type === 'datasource') {
                        const dependentWorkflows = dsToWorkflows.get(currentId) || [];
                        for (const nextWfId of dependentWorkflows) {
                            const nextNodeId = `wf-${nextWfId}`;
                            if (!visited.has(nextNodeId)) {
                                visited.add(nextNodeId);
                                queue.push({ id: nextNodeId, type: 'workflow' });
                            }
                        }
                    } else { 
                        const nextDsIds = workflowToDs.get(currentId) || [];
                        for (const nextDsId of nextDsIds) {
                            const nextNodeId = `ds-${nextDsId}`;
                            if (!visited.has(nextNodeId)) {
                                visited.add(nextNodeId);
                                queue.push({ id: nextNodeId, type: 'datasource' });
                            }
                        }
                    }
                }
                results.push({ ...wf, criticalityScore: score });
            }
            
            results.sort((a, b) => b.criticalityScore - a.criticalityScore);
    
            return { success: true, data: results };
        } catch (error) {
            showDbError(error);
            return { success: false, error: error.message };
        }
    });

    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        if (db) db.close();
        app.quit();
    }
});