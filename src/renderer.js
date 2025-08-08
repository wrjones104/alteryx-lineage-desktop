// src/renderer.js (Final Corrected Version)

// --- App State ---
let allData = { workflows: [], datasources: [], connections: [] };
let currentEditingDsId = null;
let d3Graph = {};
let currentWorkflowToDelete = null;

// --- UI Elements (to be assigned when the DOM is ready) ---
let fileInput, dropZone, reportView,
    graphView, tooltipEl, resultsDiv, reportSearchInput, graphSearchInput,
    graphSearchBtn, graphSearchResults, connectionsModal, connectionsModalContent,
    connectionsModalTitle, closeConnectionsModalBtn, aliasEditor,
    originalNameEl, aliasInput, saveAliasBtn, cancelAliasBtn,
    welcomeView, mainView, createBtn, openBtn, recentsList, addWorkflowModal,
    addWorkflowBtn, closeAddWorkflowModalBtn, graphSearchContainer, reportSearchContainer,
    deleteWorkflowBtn, deleteConfirmModal, deletingWorkflowName,
    deleteConfirmInput, cancelDeleteBtn, confirmDeleteBtn,
    showGraphBtn, showReportBtn, showImpactBtn,
    analysisView, analysisResults, graphDropZone,
    progressOverlay, progressText, impactSearchInput, impactSearchContainer;

// --- Core Functions ---
async function handleFiles(files) {
    if (files.length === 0) return;

    progressOverlay.classList.remove('hidden');

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        progressText.textContent = `Processing ${i + 1} of ${files.length}: ${file.name}`;

        if (file.name.endsWith('.yxmd')) {
            try {
                const fileContent = await readFileAsText(file);
                const workflowData = parseWorkflow(fileContent, file.name);
                await window.electronAPI.saveWorkflow(workflowData);
            } catch (error) {
                console.error(`Error processing file ${file.name}:`, error);
            }
        }
    }

    allData = await window.electronAPI.loadAllData();
    displayReport(allData.workflows, allData.datasources, allData.connections);
    
    const currentView = document.querySelector('.view-toggle-btn.bg-blue-500')?.id;
    if (currentView === 'show-graph-btn' || allData.workflows.length === 0) {
        await renderGraph(allData.workflows, allData.datasources, allData.connections);
    }

    progressOverlay.classList.add('hidden');
    progressText.textContent = '';
    if (fileInput) fileInput.value = '';
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
        card.id = `workflow-card-${workflow.id}`;

        const deleteBtnHTML = `<button onclick="window.requestDeleteWorkflow(${workflow.id}, '${workflow.name.replace(/'/g, "\\'")}')" class="text-slate-400 hover:text-red-600 p-1 rounded-full hover:bg-red-100" title="Delete Workflow">
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                               </button>`;
        let content = `<div class="flex justify-between items-center border-b pb-2 mb-4">
                        <h3 class="text-xl font-bold text-slate-800 break-all">${workflow.name}</h3>
                        ${deleteBtnHTML}
                       </div>`;

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
        content += `<div class="grid grid-cols-1 md:grid-cols-2 gap-6">`;
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
                     <button onclick="window.showConnectionsModal({ id: 'ds-${item.id}', name: '${item.value.connection.replace(/'/g, "\\'")}', alias: '${(item.alias || '').replace(/'/g, "\\'")}', type: '${item.type}' })" class="ml-2 p-1 rounded-full hover:bg-gray-200 flex-shrink-0">
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
    return new Promise(resolve => {
        const graphContainer = d3.select("#graph-container");
        
        if (graphContainer.node().offsetParent === null) {
            resolve();
            return;
        }

        // Clear the container of any previous SVG, but leave the drop zone element
        graphContainer.selectAll("svg").remove();
        graphDropZone.classList.add('hidden'); // Hide drop zone by default

        if (!workflows || workflows.length === 0 && (!datasources || datasources.length === 0)) {
            // EMPTY STATE: Show the drop zone.
            graphDropZone.classList.remove('hidden');
            resolve();
            return;
        }

        const fileNameCounts = datasources.reduce((acc, ds) => {
            const fileName = ds.name.split('\\').pop().split('/').pop();
            acc[fileName] = (acc[fileName] || 0) + 1;
            return acc;
        }, {});
        const duplicateFileNames = new Set();
        for (const fileName in fileNameCounts) {
            if (fileNameCounts[fileName] > 1) {
                duplicateFileNames.add(fileName);
            }
        }
        const width = graphContainer.node().getBoundingClientRect().width;
        const height = graphContainer.node().getBoundingClientRect().height;
        const zoom = d3.zoom().on("zoom", e => g.attr("transform", e.transform));
        const svg = graphContainer.append("svg").attr("width", width).attr("height", height).call(zoom);
        const g = svg.append("g");
        const tooltip = d3.select(tooltipEl);
        const wfNodes = workflows.map(d => ({ id: `wf-${d.id}`, name: d.name, type: 'workflow' }));
        const dsNodes = datasources.map(d => {
            const fileName = d.name.split('\\').pop().split('/').pop();
            const smartName = duplicateFileNames.has(fileName) ? d.name : fileName;
            return { id: `ds-${d.id}`, name: d.name, displayName: d.alias || smartName, type: d.type, alias: d.alias };
        });
        const nodes = [...wfNodes, ...dsNodes];
        d3Graph.nodes = nodes;
        d3Graph.svg = svg;
        d3Graph.zoom = zoom;
        d3Graph.width = width;
        d3Graph.height = height;
        const links = connections.map(d => ({ source: d.direction === 'input' ? `ds-${d.dsId}` : `wf-${d.workflowId}`, target: d.direction === 'input' ? `wf-${d.workflowId}` : `ds-${d.dsId}` }));
        const simulation = d3.forceSimulation(nodes)
            .force("link", d3.forceLink(links).id(d => d.id).distance(100))
            .force("charge", d3.forceManyBody().strength(-300))
            .force("center", d3.forceCenter(width / 2, height / 2))
            .on('end', resolve);

        svg.append("defs").append("marker").attr("id", "arrowhead").attr("viewBox", "-0 -5 10 10").attr("refX", 25).attr("refY", 0).attr("orient", "auto").attr("markerWidth", 8).attr("markerHeight", 8).append("svg:path").attr("d", "M0,-5L10,0L0,5").attr("fill", "#94a3b8");
        const link = g.append("g").selectAll("line").data(links).join("line").attr("class", "link").attr("stroke-width", 2).attr("marker-end", "url(#arrowhead)");
        const node = g.append("g").selectAll("g").data(nodes).join("g").call(drag(simulation));
        node.append("circle").filter(d => d.type === 'workflow').attr("r", 15).attr("class", "node-workflow");
        node.append("rect").filter(d => d.type === 'File' || d.type === 'Database').attr("width", 30).attr("height", 20).attr("x", -15).attr("y", -10).attr("rx", 3).attr("ry", 3).attr("class", "node-datasource");
        node.append("path").filter(d => d.type === 'API').attr('d', 'M-15,-10 h30 v20 h-30 z M-15,0 h30 M-10,-10 v20 M10,-10 v20').attr('class', 'node-api');
        node.append("text").attr("class", "node-label").attr("dy", d => d.type === 'workflow' ? 25 : 22).attr("text-anchor", "middle").text(d => { const label = d.displayName || d.name; return label.length > 20 ? label.substring(0, 18) + '...' : label; });
        node.on("mouseover", (event, d) => { tooltip.transition().duration(200).style("opacity", .9); tooltip.html(d.name).style("left", (event.pageX + 5) + "px").style("top", (event.pageY - 28) + "px"); }).on("mouseout", () => { tooltip.transition().duration(500).style("opacity", 0); });
        node.on('click', (event, d) => { const nodeData = { id: d.id, name: d.name, alias: d.alias, type: d.type }; showConnectionsModal(nodeData); });
        simulation.on("tick", () => { link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y); node.attr("transform", d => `translate(${d.x},${d.y})`); });
        function drag(simulation) {
            function dragstarted(event, d) { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
            function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
            function dragended(event, d) { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }
            return d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended);
        }
    });
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
    const allConnections = [...inputs, ...outputs];
    const allUniqueQueries = [...new Set(allConnections.map(c => c.query).filter(q => q))];
    const createLinkList = (connections) => {
        if (connections.length === 0) return '<p class="text-sm text-gray-500">None</p>';
        return `<ul class="list-disc pl-5 space-y-2">${connections.map(c => { const otherNodeId = isWorkflow ? c.dsId : c.workflowId; const otherNode = isWorkflow ? dsMap.get(otherNodeId) : wfMap.get(otherNodeId); if (!otherNode) return ''; const displayName = otherNode.alias || otherNode.name; const linkHTML = `<a href="#" onclick="window.panToNodeAndClose('${displayName.replace(/'/g, "\\'")}')" class="text-blue-600 hover:underline">${displayName}</a>`; return `<li class="break-all">${linkHTML}</li>`; }).join('')}</ul>`;
    };
    connectionsModalTitle.innerHTML = `<span class="font-normal">Inspector:</span> <b class="break-all">${nodeData.alias || nodeData.name}</b>`;
    let content = `<div class="grid grid-cols-2 gap-4 mt-4"><div><h4 class="font-semibold text-gray-800 border-b pb-1 mb-2">Inputs</h4>${createLinkList(isWorkflow ? inputs : outputs)}</div><div><h4 class="font-semibold text-gray-800 border-b pb-1 mb-2">Outputs</h4>${createLinkList(isWorkflow ? outputs : inputs)}</div></div>`;
    if (!isWorkflow && allUniqueQueries.length > 0) {
        const uniqueId = `modal-query-main-${nodeId}`;
        const arrowId = `modal-arrow-main-${nodeId}`;
        const queriesHTML = allUniqueQueries.map(q => `<pre class="bg-slate-100 p-2 rounded-md text-xs text-slate-800 max-h-60 overflow-y-auto">${q.trim()}</pre>`).join('<hr class="my-2">');
        content += `<div class="mt-4 pt-4 border-t"><button onclick="toggleQuery('${uniqueId}', '${arrowId}')" class="flex items-center text-sm font-semibold text-slate-700 hover:text-slate-900 focus:outline-none"><svg id="${arrowId}" xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-1 transition-transform duration-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>Query Details</button><div id="${uniqueId}" class="hidden mt-2 space-y-2">${queriesHTML}</div></div>`;
    }
    connectionsModalContent.innerHTML = content;
    
    if (isWorkflow) {
        deleteWorkflowBtn.classList.remove('hidden');
        aliasEditor.classList.add('hidden');
        currentWorkflowToDelete = { id: nodeId, name: nodeData.name };
    } else {
        deleteWorkflowBtn.classList.add('hidden');
        aliasEditor.classList.remove('hidden');
        currentEditingDsId = nodeId;
        originalNameEl.textContent = nodeData.name;
        aliasInput.value = nodeData.alias || '';
        currentWorkflowToDelete = null; 
    }
    connectionsModal.classList.remove('hidden');
}

// --- Startup Block ---
window.addEventListener('DOMContentLoaded', () => {
    // --- Assign UI Elements from the DOM ---
    welcomeView = document.getElementById('welcome-view');
    mainView = document.getElementById('main-view');
    createBtn = document.getElementById('create-new-btn');
    openBtn = document.getElementById('open-existing-btn');
    recentsList = document.getElementById('recents-list');
    dropZone = document.getElementById('drop-zone');
    fileInput = document.getElementById('file-input');
    reportView = document.getElementById('report-view');
    graphView = document.getElementById('graph-view');
    tooltipEl = document.getElementById('tooltip');
    resultsDiv = document.getElementById('results');
    graphSearchContainer = document.getElementById('graph-search-container');
    reportSearchContainer = document.getElementById('report-search-container');
    impactSearchContainer = document.getElementById('impact-search-container');
    reportSearchInput = document.getElementById('report-search-input');
    graphSearchInput = document.getElementById('graph-search-input');
    graphSearchBtn = document.getElementById('graph-search-btn');
    graphSearchResults = document.getElementById('graph-search-results');
    addWorkflowModal = document.getElementById('add-workflow-modal');
    addWorkflowBtn = document.getElementById('add-workflow-btn');
    closeAddWorkflowModalBtn = document.getElementById('close-add-workflow-modal-btn');
    connectionsModal = document.getElementById('connections-modal');
    connectionsModalContent = document.getElementById('modal-content');
    connectionsModalTitle = document.getElementById('modal-title');
    closeConnectionsModalBtn = document.getElementById('close-connections-modal');
    aliasEditor = document.getElementById('alias-editor');
    originalNameEl = document.getElementById('original-name');
    aliasInput = document.getElementById('alias-input');
    saveAliasBtn = document.getElementById('save-alias-btn');
    cancelAliasBtn = document.getElementById('cancel-alias-btn');
    deleteWorkflowBtn = document.getElementById('delete-workflow-btn');
    deleteConfirmModal = document.getElementById('delete-confirm-modal');
    deletingWorkflowName = document.getElementById('deleting-workflow-name');
    deleteConfirmInput = document.getElementById('delete-confirm-input');
    cancelDeleteBtn = document.getElementById('cancel-delete-btn');
    confirmDeleteBtn = document.getElementById('confirm-delete-btn');
    showGraphBtn = document.getElementById('show-graph-btn');
    showReportBtn = document.getElementById('show-report-btn');
    showImpactBtn = document.getElementById('show-impact-btn');
    analysisView = document.getElementById('analysis-view');
    analysisResults = document.getElementById('analysis-results');
    graphDropZone = document.getElementById('graph-drop-zone');
    progressOverlay = document.getElementById('progress-overlay');
    progressText = document.getElementById('progress-text');
    impactSearchInput = document.getElementById('impact-search-input');

    const activeBtnClasses = ['bg-blue-500', 'text-white'];
    const inactiveBtnClasses = ['text-slate-600', 'hover:bg-slate-100'];

    function switchView(viewName) {
        [graphView, reportView, analysisView].forEach(v => v.classList.add('hidden'));
        [showGraphBtn, showReportBtn, showImpactBtn].forEach(b => {
            b.classList.remove(...activeBtnClasses);
            b.classList.add(...inactiveBtnClasses);
        });
        
        [graphSearchContainer, reportSearchContainer, impactSearchContainer].forEach(c => c.classList.add('hidden'));

        let promise = Promise.resolve();

        if (viewName === 'graph') {
            graphView.classList.remove('hidden');
            graphSearchContainer.classList.remove('hidden');
            showGraphBtn.classList.add(...activeBtnClasses);
            showGraphBtn.classList.remove(...inactiveBtnClasses);
            promise = renderGraph(allData.workflows, allData.datasources, allData.connections);
        } else if (viewName === 'report') {
            reportView.classList.remove('hidden');
            reportSearchContainer.classList.remove('hidden');
            showReportBtn.classList.add(...activeBtnClasses);
            showReportBtn.classList.remove(...inactiveBtnClasses);
        } else if (viewName === 'impact') {
            analysisView.classList.remove('hidden');
            impactSearchContainer.classList.remove('hidden');
            showImpactBtn.classList.add(...activeBtnClasses);
            showImpactBtn.classList.remove(...inactiveBtnClasses);
        }
        return promise;
    }

    const showMainView = async () => {
        welcomeView.classList.add('hidden');
        mainView.classList.remove('hidden');
        allData = await window.electronAPI.loadAllData();
        displayReport(allData.workflows, allData.datasources, allData.connections);
        switchView('graph');
    };

    // --- Event Listeners ---
    createBtn.addEventListener('click', async () => { if (await window.electronAPI.createDbFile()) showMainView(); });
    openBtn.addEventListener('click', async () => { if (await window.electronAPI.openDbFile()) showMainView(); });
    recentsList.addEventListener('click', async (e) => {
        if (e.target.tagName === 'BUTTON' && e.target.dataset.path) {
            if (await window.electronAPI.openDbFile(e.target.dataset.path)) showMainView();
        }
    });
    window.electronAPI.onOpenRecentFile(async (filePath) => { if (filePath && await window.electronAPI.openDbFile(filePath)) showMainView(); });

    addWorkflowBtn.addEventListener('click', () => addWorkflowModal.classList.remove('hidden'));
    closeAddWorkflowModalBtn.addEventListener('click', () => addWorkflowModal.classList.add('hidden'));

    showGraphBtn.addEventListener('click', () => switchView('graph'));
    showReportBtn.addEventListener('click', () => switchView('report'));
    showImpactBtn.addEventListener('click', async () => {
        analysisResults.innerHTML = '<div class="loader-small mx-auto"></div>';
        impactSearchInput.value = '';
        await switchView('impact');
        const result = await window.electronAPI.calculateCriticality();

        if (result.success) {
            analysisResults.innerHTML = '';
            const table = document.createElement('table');
            table.className = 'min-w-full divide-y divide-gray-200 bg-white rounded-lg shadow-md';
            table.innerHTML = `
                <thead class="bg-gray-50">
                    <tr>
                        <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Rank</th>
                        <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Workflow Name</th>
                        <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Criticality Score</th>
                        <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                    </tr>
                </thead>
                <tbody class="bg-white divide-y divide-gray-200"></tbody>
            `;
            const tbody = table.querySelector('tbody');
            if (result.data.length === 0) {
                 analysisResults.innerHTML = '<p class="text-slate-500">No workflows to analyze.</p>';
            } else {
                result.data.forEach((wf, index) => {
                    const row = tbody.insertRow();
                    const escapedName = wf.name.replace(/'/g, "\\'");
                    row.innerHTML = `
                        <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${index + 1}</td>
                        <td class="px-6 py-4 text-sm text-gray-800 break-all">${wf.name}</td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm font-bold text-indigo-600">${wf.criticalityScore}</td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">
                            <button onclick="window.jumpToGraphNode('${escapedName}')" class="text-indigo-600 hover:text-indigo-900">Graph</button>
                            <button onclick="window.jumpToReportCard(${wf.id})" class="text-indigo-600 hover:text-indigo-900">Report</button>
                        </td>
                    `;
                });
                analysisResults.appendChild(table);
            }
        } else {
            analysisResults.innerHTML = '<p class="text-red-500">Error calculating impact scores.</p>';
            console.error("Failed to calculate criticality:", result.error);
        }
    });

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        handleFiles(e.dataTransfer.files);
        setTimeout(() => addWorkflowModal.classList.add('hidden'), 500);
    });
    fileInput.addEventListener('change', () => {
        handleFiles(fileInput.files);
        setTimeout(() => addWorkflowModal.classList.add('hidden'), 500);
    });

    // --- Graph View Drag and Drop ---
    graphView.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (allData.workflows.length > 0) {
            graphDropZone.classList.remove('hidden');
            graphDropZone.classList.add('absolute', 'bg-slate-50/80', 'backdrop-blur-sm');
        }
    });
    graphView.addEventListener('dragleave', (e) => {
        e.preventDefault();
        if (!graphView.contains(e.relatedTarget)) {
            graphDropZone.classList.add('hidden');
            graphDropZone.classList.remove('absolute', 'bg-slate-50/80', 'backdrop-blur-sm');
        }
    });
    graphView.addEventListener('dragover', e => e.preventDefault());
    graphView.addEventListener('drop', (e) => {
        e.preventDefault();
        graphDropZone.classList.add('hidden');
        graphDropZone.classList.remove('absolute', 'bg-slate-50/80', 'backdrop-blur-sm');
        handleFiles(e.dataTransfer.files);
    });

    closeConnectionsModalBtn.addEventListener('click', () => connectionsModal.classList.add('hidden'));
    cancelAliasBtn.addEventListener('click', () => connectionsModal.classList.add('hidden'));

    saveAliasBtn.addEventListener('click', async () => {
        if (currentEditingDsId) {
            await window.electronAPI.updateAlias(currentEditingDsId, aliasInput.value);
            connectionsModal.classList.add('hidden');
            currentEditingDsId = null;
            allData = await window.electronAPI.loadAllData();
            displayReport(allData.workflows, allData.datasources, allData.connections);
            renderGraph(allData.workflows, allData.datasources, allData.connections);
        }
    });

    reportSearchInput.addEventListener('input', (e) => { const searchTerm = e.target.value.toLowerCase(); displayReport(allData.workflows, allData.datasources, allData.connections, searchTerm); });
    reportSearchInput.addEventListener('focus', () => reportSearchInput.select());

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
    graphSearchInput.addEventListener('focus', () => graphSearchInput.select());

    document.addEventListener('click', (e) => { if (graphSearchInput && !graphSearchInput.contains(e.target)) { graphSearchResults.classList.add('hidden'); } });
    graphSearchBtn.addEventListener('click', () => panToNode(graphSearchInput.value));
    
    impactSearchInput.addEventListener('input', () => {
        const searchTerm = impactSearchInput.value.toLowerCase();
        const table = analysisResults.querySelector('table');
        if (!table) return;
        const rows = table.querySelectorAll('tbody tr');
        let visibleRows = 0;
        rows.forEach(row => {
            const workflowNameCell = row.cells[1];
            if (workflowNameCell.textContent.toLowerCase().includes(searchTerm)) {
                row.classList.remove('hidden');
                visibleRows++;
            } else {
                row.classList.add('hidden');
            }
        });
        
        let noResultsMsg = analysisResults.querySelector('.no-search-results');
        if (visibleRows === 0 && !noResultsMsg) {
            noResultsMsg = document.createElement('p');
            noResultsMsg.className = 'no-search-results text-slate-500 text-center py-4';
            noResultsMsg.textContent = 'No workflows match your filter.';
            table.after(noResultsMsg);
        } else if (visibleRows > 0 && noResultsMsg) {
            noResultsMsg.remove();
        }
    });

    deleteWorkflowBtn.addEventListener('click', () => {
        if (currentWorkflowToDelete) {
            connectionsModal.classList.add('hidden');
            deletingWorkflowName.textContent = currentWorkflowToDelete.name;
            deleteConfirmModal.classList.remove('hidden');
            deleteConfirmInput.focus();
        }
    });
    cancelDeleteBtn.addEventListener('click', () => {
        deleteConfirmModal.classList.add('hidden');
        deleteConfirmInput.value = '';
        confirmDeleteBtn.disabled = true;
        currentWorkflowToDelete = null;
    });
    deleteConfirmInput.addEventListener('input', () => {
        confirmDeleteBtn.disabled = deleteConfirmInput.value !== 'DELETE';
    });
    confirmDeleteBtn.addEventListener('click', async () => {
        if (currentWorkflowToDelete && deleteConfirmInput.value === 'DELETE') {
            const result = await window.electronAPI.deleteWorkflow(currentWorkflowToDelete.id);
            deleteConfirmModal.classList.add('hidden');
            deleteConfirmInput.value = '';
            confirmDeleteBtn.disabled = true;
            currentWorkflowToDelete = null;

            if (result.success) {
                allData = await window.electronAPI.loadAllData();
                displayReport(allData.workflows, allData.datasources, allData.connections);
                renderGraph(allData.workflows, allData.datasources, allData.connections);
            } else {
                console.error('Failed to delete workflow:', result.error);
            }
        }
    });

    async function populateRecents() {
        const recents = await window.electronAPI.getRecentWorkspaces();
        recentsList.innerHTML = '';
        if (recents.length === 0) {
            recentsList.innerHTML = '<p class="text-slate-400 text-sm italic">No recent workspaces.</p>';
            return;
        }
        recents.forEach(path => {
            const fileName = path.split('\\').pop().split('/').pop().replace('.sqlite', '');
            const recentBtn = document.createElement('button');
            recentBtn.className = 'w-full text-left p-2 rounded-md hover:bg-slate-200 transition-colors truncate';
            recentBtn.textContent = fileName;
            recentBtn.title = path;
            recentBtn.dataset.path = path;
            recentsList.appendChild(recentBtn);
        });
    }
    populateRecents();

    function debounce(func, timeout = 100) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => { func.apply(this, args); }, timeout); }; }
    const debouncedRender = debounce(() => { if (allData.workflows.length > 0) renderGraph(allData.workflows, allData.datasources, allData.connections) });
    window.addEventListener('resize', debouncedRender);

    // --- Global Helper Functions (defined inside DOMContentLoaded to have access to scope) ---
    window.toggleQuery = (elementId, arrowId) => {
        document.getElementById(elementId)?.classList.toggle('hidden');
        document.getElementById(arrowId)?.classList.toggle('rotate-90');
    };
    
    window.panToNodeAndClose = (nodeName) => {
        connectionsModal.classList.add('hidden');
        panToNode(nodeName);
    };
    
    window.requestDeleteWorkflow = (id, name) => {
        currentWorkflowToDelete = { id, name };
        deletingWorkflowName.textContent = name;
        deleteConfirmModal.classList.remove('hidden');
        deleteConfirmInput.focus();
    };
    
    window.jumpToGraphNode = async (workflowName) => {
        await switchView('graph');
        panToNode(workflowName);
    };
    
    window.jumpToReportCard = (workflowId) => {
        switchView('report');
        const card = document.getElementById(`workflow-card-${workflowId}`);
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('ring-2', 'ring-indigo-500', 'ring-offset-2');
            setTimeout(() => {
                card.classList.remove('ring-2', 'ring-indigo-500', 'ring-offset-2');
            }, 2500);
        }
    };
    
    window.showConnectionsModal = showConnectionsModal;
});