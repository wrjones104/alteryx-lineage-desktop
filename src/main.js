// src/main.js (Final Corrected Version)
const { app, BrowserWindow, ipcMain, dialog, Menu, MenuItem, shell } = require('electron');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const Store = require('electron-store');
let db;

const store = new Store();

let mainWindow; // Make mainWindow accessible in the global scope

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

// --- Reusable Core Functions for Handling Workspaces ---
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
        const delay = app.isPackaged ? 2000 : 3000;
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
    ipcMain.handle('open-db-file', (event, filePath) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return handleOpenWorkspace(window, filePath);
    });
    ipcMain.handle('create-db-file', (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return handleCreateWorkspace(window);
    });
    ipcMain.handle('get-recent-workspaces', () => {
        return store.get('recentWorkspaces', []);
    });
    ipcMain.handle('load-all-data', async () => {
        const workflows = await dbAll('SELECT * FROM workflows');
        const datasources = await dbAll('SELECT * FROM datasources');
        const connections = await dbAll('SELECT * FROM connections');
        return { workflows, datasources, connections };
    });
    ipcMain.handle('update-alias', async (event, { dsId, newAlias }) => {
        return dbRun('UPDATE datasources SET alias = ? WHERE id = ?', [newAlias, dsId]);
    });

    // --- DESIGN NOTE (2025-08-07) ---
    // This function de-duplicates connections before they are saved.
    // We are intentionally creating the unique key using ONLY the connection's
    // type and path, while IGNORING the query.
    //
    // REASON: This simplifies the UI by showing a single link between a
    // workflow and a data source, even if the workflow uses multiple different
    // queries against that same data source. This was a specific design choice
    // to reduce visual clutter in the Inspector and Graph views.
    //
    // TO REVERT: To show a separate connection for each unique query,
    // add `item.value.query` back into the 'key' generation string below.
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

    ipcMain.handle('save-workflow', async (event, workflowData) => {
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
        } catch (error) {
            showDbError(error);
        }
    });
    
    ipcMain.handle('delete-workflow', async (event, workflowId) => {
        if (!db) {
            showDbError({ message: "Database not open." });
            return { success: false, error: "Database not open." };
        }
        try {
            await dbRun('BEGIN TRANSACTION');
            await dbRun('DELETE FROM connections WHERE workflowId = ?', [workflowId]);
            await dbRun('DELETE FROM workflows WHERE id = ?', [workflowId]);
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