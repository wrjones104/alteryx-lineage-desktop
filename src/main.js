// src/main.js
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const Store = require('electron-store');
let db;

const store = new Store();

// --- Helper functions for making sqlite3 work with async/await ---
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

// --- Helper function for managing the recent workspaces list ---
function addWorkspaceToRecents(filePath) {
    const recents = store.get('recentWorkspaces', []);
    // Remove the path if it already exists to avoid duplicates, then add it to the front.
    const newRecents = [filePath, ...recents.filter(p => p !== filePath)];
    // Keep the list at a max of 5 items.
    store.set('recentWorkspaces', newRecents.slice(0, 5));
}

// --- Reusable Core Functions for Handling Workspaces ---
async function handleOpenWorkspace(window, filePath) {
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
    
    console.log('Connected to the SQLite database:', finalPath);
    addWorkspaceToRecents(finalPath);
    
    await dbRun('CREATE TABLE IF NOT EXISTS workflows (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
    await dbRun('CREATE TABLE IF NOT EXISTS datasources (id INTEGER PRIMARY KEY, name TEXT UNIQUE, type TEXT, alias TEXT)');
    await dbRun('CREATE TABLE IF NOT EXISTS connections (id INTEGER PRIMARY KEY, workflowId INTEGER, dsId INTEGER, direction TEXT, query TEXT)');

    return true;
}

async function handleCreateWorkspace(window) {
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
        title: 'Create New Workspace',
        defaultPath: 'alteryx-lineage.sqlite',
        filters: [{ name: 'SQLite Databases', extensions: ['sqlite', 'db'] }]
    });

    if (canceled || !filePath) return false;

    db = new sqlite3.Database(filePath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
        if (err) console.error(err.message);
    });
    
    console.log('Connected to the new SQLite database:', filePath);
    addWorkspaceToRecents(filePath);

    await dbRun('CREATE TABLE IF NOT EXISTS workflows (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
    await dbRun('CREATE TABLE IF NOT EXISTS datasources (id INTEGER PRIMARY KEY, name TEXT UNIQUE, type TEXT, alias TEXT)');
    await dbRun('CREATE TABLE IF NOT EXISTS connections (id INTEGER PRIMARY KEY, workflowId INTEGER, dsId INTEGER, direction TEXT, query TEXT)');
    
    return true;
}

// --- Main Window Creation and Menu Setup ---
// In src/main.js

const createWindow = () => {
    // 1. Create the browser window FIRST.
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "Alteryx Lineage Visualizer",
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    // 2. NOW that mainWindow exists, we can build the menu that references it.
    const recentWorkspacesMenu = store.get('recentWorkspaces', [])
        .map(filePath => ({
            label: filePath.split('\\').pop().split('/').pop(),
            click: () => handleOpenWorkspace(mainWindow, filePath)
        }));

    const menuTemplate = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'Create New Workspace',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => handleCreateWorkspace(mainWindow)
                },
                {
                    label: 'Open Workspace...',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => handleOpenWorkspace(mainWindow, null)
                },
                {
                    label: 'Open Recent',
                    submenu: recentWorkspacesMenu
                },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'Edit',
            submenu: [ { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' } ]
        },
        {
            label: 'View',
            submenu: [ { role: 'reload' }, { role: 'toggleDevTools' }]
        }
    ];

    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);

    // 3. Finally, load the initial HTML file.
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
};

// --- App Lifecycle and IPC Handlers ---
app.whenReady().then(() => {
    // These IPC handlers are called by the welcome screen and renderer process
    ipcMain.handle('open-db-file', (event, filePath) => {
        return handleOpenWorkspace(BrowserWindow.fromWebContents(event.sender), filePath);
    });
    ipcMain.handle('create-db-file', (event) => {
        return handleCreateWorkspace(BrowserWindow.fromWebContents(event.sender));
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
    ipcMain.handle('save-workflow', async (event, workflowData) => {
        let workflow = await dbGet('SELECT id FROM workflows WHERE name = ?', [workflowData.name]);
        if (workflow) {
            await dbRun('DELETE FROM connections WHERE workflowId = ?', [workflow.id]);
        } else {
            const result = await dbRun('INSERT INTO workflows (name) VALUES (?)', [workflowData.name]);
            workflow = { id: result.lastID };
        }

        const processConnections = async (items, direction) => {
            for (const item of items) {
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