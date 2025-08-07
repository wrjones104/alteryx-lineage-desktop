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

function showDbError(error) {
    // Log the full error to the terminal for debugging
    console.error("Database Error:", error);
    // Show a user-friendly error box
    dialog.showErrorBox(
        "Database Error",
        "An error occurred while interacting with the workspace. Please try again.\n\nDetails: " + error.message
    );
}

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

        console.log('Connected to the SQLite database:', finalPath);
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

        console.log('Connected to the new SQLite database:', filePath);
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
// In src/main.js

const createWindow = () => {
    // 1. Create the splash window (with the new background color)
    const splashWindow = new BrowserWindow({
        width: 640,
        height: 448,
        transparent: true,
        frame: false,
        alwaysOnTop: true
    });
    splashWindow.loadFile(path.join(__dirname, 'splash.html'));

    // 2. Create the main window, but keep it hidden
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "Alteryx Lineage Visualizer",
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    // Load the main application window's HTML file.
    mainWindow.loadFile(path.join(__dirname, 'index.html'));


    // The menu logic remains the same
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
            submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
        },
        {
            label: 'View',
            submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }]
        }
    ];

    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);

    // 3. Finally, load the initial HTML file.
    // This promise will resolve when the main window is ready to show
    const mainWindowReady = new Promise(resolve => {
        mainWindow.once('ready-to-show', resolve);
    });

    // This promise will resolve after a 2-second delay
    const minSplashTime = new Promise(resolve => {
        // We only apply the delay in development mode
        const delay = app.isPackaged ? 0 : 2000; // 0 seconds in production, 2 seconds in dev
        setTimeout(resolve, delay);
    });

    // Wait for BOTH the window to be ready AND the minimum time to pass
    Promise.all([mainWindowReady, minSplashTime]).then(() => {
        splashWindow.destroy();
        mainWindow.show();
    });
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
        try {
            console.log(`--- Starting save for: ${workflowData.name} ---`);

            let workflow = await dbGet('SELECT id FROM workflows WHERE name = ?', [workflowData.name]);
            if (workflow) {
                console.log(`Workflow found (ID: ${workflow.id}). Deleting old connections.`);
                await dbRun('DELETE FROM connections WHERE workflowId = ?', [workflow.id]);
            } else {
                const result = await dbRun('INSERT INTO workflows (name) VALUES (?)', [workflowData.name]);
                workflow = { id: result.lastID };
                console.log(`New workflow created (ID: ${workflow.id}).`);
            }

            const processConnections = async (items, direction) => {
                console.log(`Processing ${items.length} ${direction}(s)...`);
                for (const item of items) {
                    console.log(` -> Looking for datasource: ${item.value.connection}`);
                    let datasource = await dbGet('SELECT id FROM datasources WHERE name = ?', [item.value.connection]);
                    if (!datasource) {
                        const result = await dbRun('INSERT INTO datasources (name, type, alias) VALUES (?, ?, ?)', [item.value.connection, item.type, '']);
                        datasource = { id: result.lastID };
                        console.log(`    New datasource created (ID: ${datasource.id})`);
                    } else {
                        console.log(`    Datasource found (ID: ${datasource.id})`);
                    }

                    console.log(`    INSERTING connection: { workflowId: ${workflow.id}, dsId: ${datasource.id}, direction: ${direction} }`);
                    await dbRun('INSERT INTO connections (workflowId, dsId, direction, query) VALUES (?, ?, ?, ?)', [workflow.id, datasource.id, direction, item.value.query]);
                }
            };

            await processConnections(workflowData.inputs, 'input');
            await processConnections(workflowData.outputs, 'output');

            console.log(`--- Finished save for: ${workflowData.name} ---`);
        } catch (error) {
            showDbError(error);
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