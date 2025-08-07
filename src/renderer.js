// src/renderer.js

// --- App State ---
let allData = { workflows: [], datasources: [], connections: [] };
let currentEditingDsId = null;
let d3Graph = {};

// --- UI Elements (to be assigned when the DOM is ready) ---
let loader, fileInput, dropZone, viewToggleBtn, printGraphBtn, reportView,
    graphView, tooltipEl, resultsDiv, reportSearchInput, graphSearchInput,
    graphSearchBtn, graphSearchResults, connectionsModal, connectionsModalContent,
    connectionsModalTitle, closeConnectionsModalBtn, aliasEditor,
    originalNameEl, aliasInput, saveAliasBtn, cancelAliasBtn,
    welcomeView, mainView, createBtn, openBtn, recentsList;

// --- Core Functions ---
async function handleFiles(files) {
    loader.classList.remove('hidden');
    for (const file of files) {
        if (file.name.endsWith('.yxmd')) {
            try {
                const fileContent = await readFileAsText(file);
                const workflowData = parseWorkflow(fileContent, file.name);
                await window.electronAPI.saveWorkflow(workflowData);

                // Re-fetch all data from the database now that it's been updated
                allData = await window.electronAPI.loadAllData();
                // Re-render the graph and report with the new data
                displayReport(allData.workflows, allData.datasources, allData.connections);
                renderGraph(allData.workflows, allData.datasources, allData.connections);

            } catch (error) {
                console.error(`Error processing file ${file.name}:`, error);
            }
        }
    }
    loader.classList.add('hidden');
    fileInput.value = '';
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

function parseWorkflow(xmlString, fileName) {
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
                value = isDb && path.includes('|||') ? { connection: path.split('|||')[0], query: path.split('|||')[1] || '' } : { connection: path, query: '' };
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

// --- UI & Rendering Functions ---
function displayReport(workflows, datasources, connections, searchTerm = '') {
    resultsDiv.innerHTML = '';
    if (!workflows || workflows.length === 0) {
        resultsDiv.innerHTML = '<p class="text-slate-500">No workflows analyzed yet.</p>';
        return;
    }
    let queryCounter = 0;
    const dsMap = new Map(Array.isArray(datasources) ? datasources.map(ds => [ds.id, ds]) : []);
    const filteredWorkflows = workflows.filter(workflow => {
        if (!searchTerm) return true;
        if (workflow.name.toLowerCase().includes(searchTerm)) return true;
        const workflowConnections = connections.filter(c => c.workflowId === workflow.id);
        for (const conn of workflowConnections) {
            const ds = dsMap.get(conn.dsId);
            if (ds) {
                if (ds.name.toLowerCase().includes(searchTerm)) return true;
                if (ds.alias && ds.alias.toLowerCase().includes(searchTerm)) return true;
            }
            if (conn.query && conn.query.toLowerCase().includes(searchTerm)) return true;
        }
        return false;
    });

    if (filteredWorkflows.length === 0) {
        resultsDiv.innerHTML = '<p class="text-slate-500">No workflows match your search.</p>';
        return;
    }

    filteredWorkflows.forEach(workflow => {
        const card = document.createElement('div');
        card.className = 'bg-white p-6 rounded-xl shadow-md';
        let content = `<h3 class="text-xl font-bold text-slate-800 border-b pb-2 mb-4">${workflow.name}</h3><div class="grid grid-cols-1 md:grid-cols-2 gap-6">`;
        const workflowConnections = connections.filter(c => c.workflowId === workflow.id);
        const inputs = workflowConnections.filter(c => c.direction === 'input');
        const outputs = workflowConnections.filter(c => c.direction === 'output');
        const renderList = (items, color) => {
            if (items.length === 0) return `<p class="text-slate-500 italic text-sm">No ${color === 'green' ? 'inputs' : 'outputs'} found.</p>`;
            return `<ul class="space-y-2">${items.map(conn => {
                const ds = dsMap.get(conn.dsId);
                if (!ds) return '';
                const item = { type: ds.type, value: { connection: ds.name, query: conn.query }, alias: ds.alias, id: ds.id };
                return renderListItem(item, color, queryCounter++);
            }).join('')}</ul>`;
        };
        content += `<div><h4 class="text-lg font-semibold text-green-700 mb-3">Inputs</h4>${renderList(inputs, 'green')}</div>`;
        content += `<div><h4 class="text-lg font-semibold text-red-700 mb-3">Outputs</h4>${renderList(outputs, 'red')}</div>`;
        content += '</div>';
        card.innerHTML = content;
        resultsDiv.appendChild(card);
    });
}

function renderListItem(item, color, id) {
    const bgColor = color === 'green' ? 'bg-green-50' : 'bg-red-50';
    const uniqueId = `query-${id}`;
    const arrowId = `arrow-${id}`;
    let content = `<div class="flex justify-between items-start">
                     <div class="break-all">${renderPill(item.type)} <b>${item.alias || item.value.connection}</b>
                        ${item.alias ? `<span class="text-xs text-gray-500">(${item.value.connection})</span>` : ''}
                     </div>
                     <button onclick="window.showConnectionsModal({ id: 'ds-${item.id}', name: '${item.value.connection}', alias: '${item.alias || ''}', type: '${item.type}' })" class="ml-2 p-1 rounded-full hover:bg-gray-200 flex-shrink-0">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.536L16.732 3.732z" /></svg>
                     </button>
                   </div>`;
    if ((item.type === 'Database' || item.type === 'API') && item.value.query) {
        content += `<div class="mt-2">
            <button onclick="toggleQuery('${uniqueId}', '${arrowId}')" class="flex items-center text-xs font-semibold text-slate-600 hover:text-slate-800 focus:outline-none">
                <svg id="${arrowId}" xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-1 transition-transform duration-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
                Show Details
            </button>
            <div id="${uniqueId}" class="hidden mt-1 pl-4 border-l-2 border-slate-200">
                <pre class="bg-slate-100 p-2 rounded-md text-xs text-slate-800">${item.value.query.trim()}</pre>
            </div>
        </div>`;
    }
    return `<li class="p-3 ${bgColor} rounded-lg text-sm">${content}</li>`;
}

function renderPill(type) {
    const colors = { 'File': 'bg-sky-200 text-sky-800', 'Database': 'bg-amber-200 text-amber-800', 'API': 'bg-purple-200 text-purple-800' };
    return `<span class="font-mono text-xs font-bold px-2 py-1 rounded mr-2 align-top ${colors[type] || 'bg-slate-200'}">${type}</span>`;
}

function renderGraph(workflows, datasources, connections) {
    const graphContainer = d3.select("#graph-container");
    graphContainer.selectAll("*").remove();
    if (!workflows || workflows.length === 0 && (!datasources || datasources.length === 0)) {
        graphContainer.append("div").attr("class", "flex items-center justify-center h-full text-slate-500").text("No data. Drop workflow files to start.");
        return;
    }

    // --- Logic to find duplicate filenames ---
    // 1. Create a frequency map to count how many times each base filename appears.
    const fileNameCounts = datasources.reduce((acc, ds) => {
        // This handles both Windows and Unix-style paths
        const fileName = ds.name.split('\\').pop().split('/').pop();
        acc[fileName] = (acc[fileName] || 0) + 1;
        return acc;
    }, {});

    // 2. Create a Set of filenames that are duplicates for quick lookup.
    const duplicateFileNames = new Set();
    for (const fileName in fileNameCounts) {
        if (fileNameCounts[fileName] > 1) {
            duplicateFileNames.add(fileName);
        }
    }

    const width = graphContainer.node().getBoundingClientRect().width;
    const height = 600;
    const zoom = d3.zoom().on("zoom", e => g.attr("transform", e.transform));
    const svg = graphContainer.append("svg").attr("width", width).attr("height", height).call(zoom);
    const g = svg.append("g");
    const tooltip = d3.select(tooltipEl);

    const wfNodes = workflows.map(d => ({ id: `wf-${d.id}`, name: d.name, type: 'workflow' }));

    const dsNodes = datasources.map(d => {
        const fileName = d.name.split('\\').pop().split('/').pop();
        // 3. Determine the "smart" name. If it's a duplicate, use the full path, otherwise use the short filename.
        const smartName = duplicateFileNames.has(fileName) ? d.name : fileName;

        return {
            id: `ds-${d.id}`,
            name: d.name, // Original full name for tooltips
            displayName: d.alias || smartName, // Alias wins, otherwise use our smart name
            type: d.type,
            alias: d.alias
        };
    });

    const nodes = [...wfNodes, ...dsNodes];

    d3Graph.nodes = nodes;
    d3Graph.svg = svg;
    d3Graph.zoom = zoom;
    d3Graph.width = width;
    d3Graph.height = height;

    const links = connections.map(d => ({ source: d.direction === 'input' ? `ds-${d.dsId}` : `wf-${d.workflowId}`, target: d.direction === 'input' ? `wf-${d.workflowId}` : `ds-${d.dsId}` }));
    const simulation = d3.forceSimulation(nodes).force("link", d3.forceLink(links).id(d => d.id).distance(100)).force("charge", d3.forceManyBody().strength(-300)).force("center", d3.forceCenter(width / 2, height / 2));

    svg.append("defs").append("marker").attr("id", "arrowhead").attr("viewBox", "-0 -5 10 10").attr("refX", 25).attr("refY", 0).attr("orient", "auto").attr("markerWidth", 8).attr("markerHeight", 8).append("svg:path").attr("d", "M0,-5L10,0L0,5").attr("fill", "#94a3b8");

    const link = g.append("g").selectAll("line").data(links).join("line").attr("class", "link").attr("stroke-width", 2).attr("marker-end", "url(#arrowhead)");

    const node = g.append("g").selectAll("g").data(nodes).join("g").call(drag(simulation));

    node.append("circle").filter(d => d.type === 'workflow').attr("r", 15).attr("class", "node-workflow");
    node.append("rect").filter(d => d.type === 'File' || d.type === 'Database').attr("width", 30).attr("height", 20).attr("x", -15).attr("y", -10).attr("rx", 3).attr("ry", 3).attr("class", "node-datasource");
    node.append("path").filter(d => d.type === 'API').attr('d', 'M-15,-10 h30 v20 h-30 z M-15,0 h30 M-10,-10 v20 M10,-10 v20').attr('class', 'node-api');

    node.append("text")
        .attr("class", "node-label")
        .attr("dy", d => d.type === 'workflow' ? 25 : 22)
        .attr("text-anchor", "middle")
        .text(d => {
            const label = d.displayName || d.name;
            return label.length > 20 ? label.substring(0, 18) + '...' : label;
        });

    node.on("mouseover", (event, d) => {
        tooltip.transition().duration(200).style("opacity", .9);
        tooltip.html(d.name).style("left", (event.pageX + 5) + "px").style("top", (event.pageY - 28) + "px");
    }).on("mouseout", () => {
        tooltip.transition().duration(500).style("opacity", 0);
    });

    node.on('click', (event, d) => {
        const nodeData = {
            id: d.id,
            name: d.name,
            alias: d.alias,
            type: d.type
        };
        showConnectionsModal(nodeData);
    });

    simulation.on("tick", () => {
        link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
        node.attr("transform", d => `translate(${d.x},${d.y})`);
    });

    function drag(simulation) {
        function dragstarted(event, d) {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
        }
        function dragged(event, d) {
            d.fx = event.x;
            d.fy = event.y;
        }
        function dragended(event, d) {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
        }
        return d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended);
    }
}

function panToNode(nodeName) {
    const targetNode = d3Graph.nodes.find(n => (n.alias || n.name) === nodeName);
    if (targetNode) {
        const scale = 1.5;
        const x = d3Graph.width / 2 - targetNode.x * scale;
        const y = d3Graph.height / 2 - targetNode.y * scale;
        d3Graph.svg.transition().duration(750).call(d3Graph.zoom.transform, d3.zoomIdentity.translate(x, y).scale(scale));
        d3.selectAll("circle, rect, path").filter(d => d.id === targetNode.id).transition().duration(250).attr('stroke', '#ef4444').attr('stroke-width', 4).transition().duration(750).delay(500).attr('stroke-width', 2).attr('stroke', d => { if (d.type === 'workflow') return '#2563eb'; if (d.type === 'API') return '#7c3aed'; return '#475569'; });
    }
}

function showConnectionsModal(nodeData) {
    const nodeId = parseInt(nodeData.id.split('-')[1], 10);
    const isWorkflow = nodeData.type === 'workflow';
    const inputs = allData.connections.filter(c => (isWorkflow ? c.workflowId : c.dsId) === nodeId && c.direction === 'input');
    const outputs = allData.connections.filter(c => (isWorkflow ? c.workflowId : c.dsId) === nodeId && c.direction === 'output');
    const dsMap = new Map(allData.datasources.map(ds => [ds.id, ds]));
    const wfMap = new Map(allData.workflows.map(wf => [wf.id, wf]));

    // --- NEW: Gather all unique queries associated with this node ---
    const allConnections = [...inputs, ...outputs];
    const allUniqueQueries = [...new Set(allConnections.map(c => c.query).filter(q => q))]; // Gets non-empty, unique queries

    // This helper is now simpler, as it no longer handles query details.
    const createLinkList = (connections) => {
        if (connections.length === 0) return '<p class="text-sm text-gray-500">None</p>';
        return `<ul class="list-disc pl-5 space-y-2">${connections.map(c => {
            const otherNodeId = isWorkflow ? c.dsId : c.workflowId;
            const otherNode = isWorkflow ? dsMap.get(otherNodeId) : wfMap.get(otherNodeId);
            if (!otherNode) return '';
            const displayName = otherNode.alias || otherNode.name;
            const linkHTML = `<a href="#" onclick="window.panToNodeAndClose('${displayName.replace(/'/g, "\\'")}')" class="text-blue-600 hover:underline">${displayName}</a>`;
            return `<li class="break-all">${linkHTML}</li>`;
        }).join('')}</ul>`;
    };

    connectionsModalTitle.innerHTML = `<span class="font-normal">Inspector:</span> <b class="break-all">${nodeData.alias || nodeData.name}</b>`;
    let content = `<div class="grid grid-cols-2 gap-4 mt-4"><div><h4 class="font-semibold text-gray-800 border-b pb-1 mb-2">Inputs</h4>${createLinkList(isWorkflow ? inputs : outputs)}</div><div><h4 class="font-semibold text-gray-800 border-b pb-1 mb-2">Outputs</h4>${createLinkList(isWorkflow ? outputs : inputs)}</div></div>`;
    
    // --- NEW: Build the query details section if any queries exist ---
    if (!isWorkflow && allUniqueQueries.length > 0) {
        const uniqueId = `modal-query-main-${nodeId}`;
        const arrowId = `modal-arrow-main-${nodeId}`;
        const queriesHTML = allUniqueQueries.map(q => 
            // Add max-height and overflow classes to the <pre> tag to make it scrollable
            `<pre class="bg-slate-100 p-2 rounded-md text-xs text-slate-800 max-h-60 overflow-y-auto">${q.trim()}</pre>`
        ).join('<hr class="my-2">'); // Add a separator for multiple queries

        content += `
            <div class="mt-4 pt-4 border-t">
                <button onclick="toggleQuery('${uniqueId}', '${arrowId}')" class="flex items-center text-sm font-semibold text-slate-700 hover:text-slate-900 focus:outline-none">
                    <svg id="${arrowId}" xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-1 transition-transform duration-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
                    Query Details
                </button>
                <div id="${uniqueId}" class="hidden mt-2 space-y-2">
                    ${queriesHTML}
                </div>
            </div>`;
    }
    // -----------------------------------------------------------------

    connectionsModalContent.innerHTML = content;

    if (!isWorkflow) {
        aliasEditor.classList.remove('hidden');
        currentEditingDsId = nodeId;
        originalNameEl.textContent = nodeData.name;
        aliasInput.value = nodeData.alias || '';
    } else {
        aliasEditor.classList.add('hidden');
    }
    
    connectionsModal.classList.remove('hidden');
}

// --- Startup Block ---
window.addEventListener('DOMContentLoaded', () => {
    // Assign UI Elements from the DOM
    welcomeView = document.getElementById('welcome-view');
    mainView = document.getElementById('main-view');
    createBtn = document.getElementById('create-new-btn');
    openBtn = document.getElementById('open-existing-btn');
    recentsList = document.getElementById('recents-list');
    dropZone = document.getElementById('drop-zone');
    fileInput = document.getElementById('file-input');
    loader = document.getElementById('loader');
    viewToggleBtn = document.getElementById('view-toggle-btn');
    printGraphBtn = document.getElementById('print-graph-btn');
    reportView = document.getElementById('report-view');
    graphView = document.getElementById('graph-view');
    tooltipEl = document.getElementById('tooltip');
    resultsDiv = document.getElementById('results');
    reportSearchInput = document.getElementById('report-search-input');
    graphSearchInput = document.getElementById('graph-search-input');
    graphSearchBtn = document.getElementById('graph-search-btn');
    graphSearchResults = document.getElementById('graph-search-results');
    connectionsModal = document.getElementById('connections-modal');
    connectionsModalContent = document.getElementById('modal-content');
    connectionsModalTitle = document.getElementById('modal-title');
    closeConnectionsModalBtn = document.getElementById('close-connections-modal');
    aliasEditor = document.getElementById('alias-editor');
    originalNameEl = document.getElementById('original-name');
    aliasInput = document.getElementById('alias-input');
    saveAliasBtn = document.getElementById('save-alias-btn');
    cancelAliasBtn = document.getElementById('cancel-alias-btn');

    // --- View Switching Function ---
    const showMainView = async () => {
        welcomeView.classList.add('hidden');
        mainView.classList.remove('hidden');

        allData = await window.electronAPI.loadAllData();
        displayReport(allData.workflows, allData.datasources, allData.connections);
        renderGraph(allData.workflows, allData.datasources, allData.connections);

        welcomeView.classList.add('hidden');
        mainView.classList.remove('hidden');
    };

    // --- Event Listeners for Welcome Screen ---
    createBtn.addEventListener('click', async () => {
        const success = await window.electronAPI.createDbFile();
        if (success) showMainView();
    });

    openBtn.addEventListener('click', async () => {
        const success = await window.electronAPI.openDbFile();
        if (success) showMainView();
    });

    recentsList.addEventListener('click', async (e) => {
        if (e.target.tagName === 'BUTTON') {
            const filePath = e.target.dataset.path;
            if (filePath) {
                const success = await window.electronAPI.openDbFile(filePath);
                if (success) showMainView();
            }
        }
    });

    // --- Event Listeners for Main View ---
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); handleFiles(e.dataTransfer.files); });
    fileInput.addEventListener('change', () => handleFiles(fileInput.files));
    viewToggleBtn.addEventListener('click', () => {
        reportView.classList.toggle('hidden');
        graphView.classList.toggle('hidden');
        printGraphBtn.classList.toggle('hidden');
        viewToggleBtn.textContent = reportView.classList.contains('hidden') ? 'Switch to Report View' : 'Switch to Graph View';
    });
    printGraphBtn.addEventListener('click', () => window.print());
    closeConnectionsModalBtn.addEventListener('click', () => connectionsModal.classList.add('hidden'));
    cancelAliasBtn.addEventListener('click', () => connectionsModal.classList.add('hidden'));
    saveAliasBtn.addEventListener('click', async () => {
        if (currentEditingDsId) {
            await window.electronAPI.updateAlias(currentEditingDsId, aliasInput.value);
            connectionsModal.classList.add('hidden'); // This now closes the whole modal
            currentEditingDsId = null;
        }
    });
    reportSearchInput.addEventListener('input', (e) => { const searchTerm = e.target.value.toLowerCase(); displayReport(allData.workflows, allData.datasources, allData.connections, searchTerm); });
    graphSearchInput.addEventListener('input', () => {
        const searchTerm = graphSearchInput.value.toLowerCase();
        graphSearchResults.innerHTML = '';
        if (!searchTerm) { graphSearchResults.classList.add('hidden'); return; }
        const allNodes = [...allData.workflows.map(d => ({ displayName: d.name })), ...allData.datasources.map(d => ({ displayName: d.alias || d.name }))];
        const filteredNodes = allNodes.filter(node => node.displayName.toLowerCase().includes(searchTerm));
        if (filteredNodes.length > 0) {
            filteredNodes.slice(0, 10).forEach(node => {
                const item = document.createElement('div');
                item.className = 'p-2 hover:bg-gray-100 cursor-pointer text-sm truncate';
                item.textContent = node.displayName;
                item.onclick = () => { graphSearchInput.value = node.displayName; graphSearchResults.classList.add('hidden'); };
                graphSearchResults.appendChild(item);
            });
            graphSearchResults.classList.remove('hidden');
        } else {
            graphSearchResults.classList.add('hidden');
        }
    });
    document.addEventListener('click', (e) => { if (!graphSearchInput.contains(e.target)) { graphSearchResults.classList.add('hidden'); } });
    graphSearchBtn.addEventListener('click', () => { panToNode(graphSearchInput.value); });

    // --- Populate Recents on Startup ---
    async function populateRecents() {
        const recents = await window.electronAPI.getRecentWorkspaces();
        recentsList.innerHTML = '';
        if (recents.length === 0) {
            recentsList.innerHTML = '<p class="text-slate-400 text-sm italic">No recent workspaces.</p>';
            return;
        }
        recents.forEach(path => {
            const fileName = path.split('\\').pop().split('/').pop();
            const recentBtn = document.createElement('button');
            recentBtn.className = 'w-full text-left p-2 rounded-md hover:bg-slate-200 transition-colors truncate';
            recentBtn.textContent = fileName;
            recentBtn.title = path;
            recentBtn.dataset.path = path;
            recentsList.appendChild(recentBtn);
        });
    }
    populateRecents();
});

// --- Global Helper Functions ---
window.toggleQuery = (elementId, arrowId) => {
    document.getElementById(elementId)?.classList.toggle('hidden');
    document.getElementById(arrowId)?.classList.toggle('rotate-90');
};

window.panToNodeAndClose = (nodeName) => {
    connectionsModal.classList.add('hidden');
    panToNode(nodeName);
};

window.showConnectionsModal = showConnectionsModal;