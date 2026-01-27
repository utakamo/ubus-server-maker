// --- Constants ---
const LUA_HEADER = `#!/usr/bin/env lua

local jsonc = require("luci.jsonc")

local methods = {
`;

const LUA_FOOTER = `
}

local function parseInput()

    local parse = jsonc.new()
    local done, err

    while true do
        local chunk = io.read(4096)
        if not chunk then
            break
        elseif not done and not err then
            done, err = parse:parse(chunk)
        end
    end

    if not done then
        print(jsonc.stringify({
            error = err or "Incomplete input for argument parsing"
        }))
        os.exit(1)
    end

    return parse:get()
end

-- validation
local function validateArgs(func, uargs)

    local method = methods[func]
    if not method then
        print(jsonc.stringify({error = "Method not found in methods table"}))
        os.exit(1)
    end

    local n = 0
    for _, _ in pairs(uargs) do n = n + 1 end

    if method.args and n == 0 then
        print(jsonc.stringify({
            error = "Received empty arguments for " .. func ..
                " but it requires " .. jsonc.stringify(method.args)
        }))
        os.exit(1)
    end

    uargs.ubus_rpc_session = nil

    local margs = method.args or {}
    for k, v in pairs(uargs) do
        if margs[k] == nil or (v ~= nil and type(v) ~= type(margs[k])) then
            print(jsonc.stringify({
                error = "Invalid argument '" .. k .. "' for " .. func ..
                    " it requires " .. jsonc.stringify(method.args)
            }))
            os.exit(1)
        end
    end

    return method
end

-- ubus list & call
if arg[1] == "list" then
    local _, rv = nil, {}
    for _, method in pairs(methods) do rv[_] = method.args or {} end
    print((jsonc.stringify(rv):gsub(":%[%]", ":{}")))
elseif arg[1] == "call" then
    local args = parseInput()
    local method = validateArgs(arg[2], args)
    local run = method.call(args)
    print(run.result)
    os.exit(run.code or 0)
end
`;

const DEFAULT_METHODS = [
    { id: 1, name: 'sampleA', args: [], mode: 'auto', acl: 'read', code: `response.contents = "Hello"` },
    { id: 2, name: 'sampleB', args: [{ name: 'data', type: 'string' }], mode: 'auto', acl: 'read', code: `response.contents = "Your Input Data: " .. args.data` },
    { id: 3, name: 'sampleC', args: [{ name: 'hostname', type: 'string' }], mode: 'auto', acl: 'write', code: `local uci = require("luci.model.uci").cursor()
uci:set("system", "@system[0]", "hostname", args.hostname)
uci:commit("system")
response.contents = "OK"` }
];

// --- State ---
let methods = JSON.parse(JSON.stringify(DEFAULT_METHODS));
let objectName = "my_server";
let aclName = "sample";
let aclDesc = "Sample ubus method";
let selectedId = 1;
let cmEditor = null; // CodeMirror Instance

// --- DOM Elements ---
const methodListEl = document.getElementById('method-list');
const addMethodBtn = document.getElementById('add-method-btn');
const editorEmpty = document.getElementById('editor-empty');
const editorContent = document.getElementById('editor-content');
const methodNameInput = document.getElementById('method-name');
const methodNameError = document.getElementById('method-name-error');
// const methodCodeInput = document.getElementById('method-code'); // Replaced by CM
const argsContainer = document.getElementById('args-container');
const addArgBtn = document.getElementById('add-arg-btn');
const deleteMethodBtn = document.getElementById('delete-method-btn');
const luaPreview = document.getElementById('lua-preview').querySelector('code');
const aclPreview = document.getElementById('acl-preview').querySelector('code');
const downloadBtn = document.getElementById('download-btn');
const downloadAclBtn = document.getElementById('download-acl-btn');
const resetBtn = document.getElementById('reset-btn');

const modeToggle = document.getElementById('mode-toggle');
const codeHelpAuto = document.getElementById('code-help-auto');
const codeHelpManual = document.getElementById('code-help-manual');
const snippetBtns = document.querySelectorAll('.snippet-btn');
const objectNameInput = document.getElementById('object-name');
const aclNameInput = document.getElementById('acl-name');
const aclDescInput = document.getElementById('acl-desc');
const testCommandCode = document.getElementById('test-command');
const copyCmdBtn = document.getElementById('copy-cmd-btn');
const previewFilename = document.getElementById('preview-filename');
const previewAclname = document.getElementById('preview-aclname');
const aclPermRadios = document.getElementsByName('acl-perm');

// Specific selectors for Preview Area tabs
const tabBtns = document.querySelectorAll('.preview-area .tab-btn');
const tabContents = document.querySelectorAll('.preview-area .tab-content');

// --- Electron / Deploy Elements ---
const deployHostInput = document.getElementById('deploy-host');
const deployUserInput = document.getElementById('deploy-user');
const deployPassInput = document.getElementById('deploy-pass');
const deployScriptPathInput = document.getElementById('deploy-script-path');
const deployAclPathInput = document.getElementById('deploy-acl-path');
const deployBtn = document.getElementById('deploy-btn');

// --- Functions ---

function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = '';
    if (type === 'success') icon = '✅';
    else if (type === 'error') icon = '❌';
    else icon = 'ℹ️';

    toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('hide');
        toast.addEventListener('animationend', () => {
            toast.remove();
        });
    }, duration);
}

function showConfirm(message, onConfirm) {
    const modal = document.getElementById('confirm-modal');
    const msgEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');

    msgEl.textContent = message;
    modal.classList.remove('hidden');
    okBtn.focus();

    // Remove old listeners to prevent stacking
    const newOkBtn = okBtn.cloneNode(true);
    const newCancelBtn = cancelBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOkBtn, okBtn);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

    const closeModal = () => {
        modal.classList.add('hidden');
    };

    newOkBtn.addEventListener('click', () => {
        closeModal();
        onConfirm();
    });

    newCancelBtn.addEventListener('click', () => {
        closeModal();
    });
}

function init() {
    // Initialize CodeMirror
    cmEditor = CodeMirror.fromTextArea(document.getElementById("method-code"), {
        mode: "lua",
        theme: "monokai",
        lineNumbers: true,
        indentUnit: 4,
        matchBrackets: true
    });

    cmEditor.on("change", function(cm) {
        updateSelectedMethod('code', cm.getValue());
    });

    loadState();
    renderMethodList();
    renderEditor();
    updatePreviews();
    updateUIHeaders();

    // Electron Integration: Load Settings
    if (window.electronAPI) {
        window.electronAPI.getSettings().then(settings => {
            if (settings.host) deployHostInput.value = settings.host;
            if (settings.username) deployUserInput.value = settings.username;
            if (settings.password) deployPassInput.value = settings.password;
            if (settings.scriptPath) deployScriptPathInput.value = settings.scriptPath;
            if (settings.aclPath) deployAclPathInput.value = settings.aclPath;
        });

        // Auto-save settings on change
        const saveDeploySettings = () => {
            window.electronAPI.saveSettings({
                host: deployHostInput.value,
                username: deployUserInput.value,
                password: deployPassInput.value,
                scriptPath: deployScriptPathInput.value,
                aclPath: deployAclPathInput.value
            });
        };
        
        [deployHostInput, deployUserInput, deployPassInput, deployScriptPathInput, deployAclPathInput].forEach(input => {
            input.addEventListener('input', saveDeploySettings);
        });

        deployBtn.addEventListener('click', handleDeploy);
    } else {
        // Not in Electron
        deployBtn.disabled = true;
        deployBtn.title = "Available only in Electron app";
        deployBtn.textContent = "Upload (App Only)";
    }

    addMethodBtn.addEventListener('click', addMethod);
    addArgBtn.addEventListener('click', addArg);
    deleteMethodBtn.addEventListener('click', deleteMethod);
    downloadBtn.addEventListener('click', downloadLua);
    downloadAclBtn.addEventListener('click', downloadAcl);
    resetBtn.addEventListener('click', resetData);
    copyCmdBtn.addEventListener('click', copyTestCommand);

    methodNameInput.addEventListener('input', (e) => updateSelectedMethod('name', e.target.value));
    modeToggle.addEventListener('change', (e) => updateSelectedMethod('mode', e.target.checked ? 'auto' : 'manual'));
    
    aclPermRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if(e.target.checked) updateSelectedMethod('acl', e.target.value);
        });
    });

    objectNameInput.addEventListener('input', (e) => {
        objectName = e.target.value || "my_server";
        saveState();
        updateUIHeaders();
        updateTestCommand();
        updatePreviews();
    });

    aclNameInput.addEventListener('input', (e) => {
        aclName = e.target.value || "sample";
        saveState();
        updateUIHeaders();
        updatePreviews();
    });

    aclDescInput.addEventListener('input', (e) => {
        aclDesc = e.target.value;
        saveState();
        updatePreviews();
    });

    snippetBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            insertSnippet(btn.getAttribute('data-snippet'));
        });
    });

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.add('hidden'));
            btn.classList.add('active');
            document.getElementById(`tab-content-${btn.dataset.tab}`).classList.remove('hidden');
        });
    });

    // Main Tabs Logic (Editor & SSH only)
    const mainTabBtns = document.querySelectorAll('.main-tabs .tab-btn');
    const mainViews = document.querySelectorAll('.view-content');
    
    mainTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            btn.blur(); // Remove focus from tab button
            mainTabBtns.forEach(b => b.classList.remove('active'));
            mainViews.forEach(v => v.classList.remove('active'));
            
            btn.classList.add('active');
            const targetId = btn.getAttribute('data-target');
            document.getElementById(targetId).classList.add('active');
            
            // Focus Management
            if (targetId === 'editor-view') {
                if (cmEditor) setTimeout(() => cmEditor.focus(), 10);
            } else if (targetId === 'ssh-view') {
                if (term) setTimeout(() => term.focus(), 10);
            }

            // Resize terminal if visible
            if (targetId === 'ssh-view' && term) {
                setTimeout(() => {
                    fitAddon.fit();
                    if(window.electronAPI) window.electronAPI.resizeSSH({ cols: term.cols, rows: term.rows });
                }, 10);
            }
        });
    });

    // Gemini Tab Logic
    const showPreviewBtn = document.getElementById('show-preview-btn');
    const showChatBtn = document.getElementById('toggle-gemini-btn');
    const geminiOverlay = document.getElementById('gemini-overlay');
    const previewWrapper = document.getElementById('preview-content-wrapper');
    let lastFocusedElement = null;

    function switchToPreview() {
        if (!geminiOverlay.classList.contains('hidden')) {
            geminiOverlay.classList.add('hidden');
            previewWrapper.style.display = 'flex';
            
            showPreviewBtn.classList.add('active');
            showChatBtn.classList.remove('active');
            
            // Ensure settings panel is closed
            if(settingsPanel) settingsPanel.classList.add('hidden');

            if (cmEditor) cmEditor.focus();
        }
    }

    function switchToChat() {
        if (geminiOverlay.classList.contains('hidden')) {
            // Save focus before opening
            lastFocusedElement = document.activeElement;

            geminiOverlay.classList.remove('hidden');
            previewWrapper.style.display = 'none';
            
            showChatBtn.classList.add('active');
            showPreviewBtn.classList.remove('active');
            
            // Focus chat input
            setTimeout(() => document.getElementById('chat-input').focus(), 50);
        }
    }

    showPreviewBtn.addEventListener('click', switchToPreview);
    showChatBtn.addEventListener('click', switchToChat);

    if (window.electronAPI) {
        initTerminal();
    }

    // Layout Toggle Logic
    document.getElementById('toggle-sidebar-btn').addEventListener('click', () => {
        document.querySelector('.sidebar').classList.toggle('collapsed');
        // Update button icon
        const btn = document.getElementById('toggle-sidebar-btn');
        btn.textContent = document.querySelector('.sidebar').classList.contains('collapsed') ? '➡' : '⬅️';
        
        setTimeout(() => { if(fitAddon) fitAddon.fit(); if(window.electronAPI) window.electronAPI.resizeSSH({ cols: term.cols, rows: term.rows }); }, 310);
    });

    document.getElementById('toggle-preview-btn').addEventListener('click', () => {
        document.querySelector('.preview-area').classList.toggle('collapsed');
        // Update button icon
        const btn = document.getElementById('toggle-preview-btn');
        btn.textContent = document.querySelector('.preview-area').classList.contains('collapsed') ? '⬅' : '➡️';

        setTimeout(() => { if(fitAddon) fitAddon.fit(); if(window.electronAPI) window.electronAPI.resizeSSH({ cols: term.cols, rows: term.rows }); }, 310);
    });
}

async function handleDeploy() {
    if (!deployHostInput.value || !deployUserInput.value) {
        showToast("Please provide Host IP and Username.", "error");
        return;
    }

    const originalText = deployBtn.textContent;
    deployBtn.textContent = "Uploading...";
    deployBtn.disabled = true;

    // Prepare data
    const luaContent = luaPreview.textContent; // Generated via updatePreviews()
    const aclContent = aclPreview.textContent;

    const data = {
        connection: {
            host: deployHostInput.value,
            username: deployUserInput.value,
            password: deployPassInput.value,
            scriptPath: deployScriptPathInput.value,
            aclPath: deployAclPathInput.value
        },
        files: {
            lua: {
                filename: objectName,
                content: luaContent
            },
            acl: {
                filename: `${aclName}.json`,
                content: aclContent
            }
        }
    };

    try {
        const result = await window.electronAPI.deployFiles(data);
        
        let outputMessage = "";
        if (result.success) {
            outputMessage = "\r\n\x1b[32m[IDE] Deployment Successful!\x1b[0m\r\n" + result.messages.join("\r\n") + "\r\n";
            showToast("Deployment Successful!", "success");
        } else {
            outputMessage = "\r\n\x1b[31m[IDE] Deployment Failed:\x1b[0m\r\n" + result.error + "\r\n";
            showToast("Deployment Failed: " + result.error, "error", 5000);
        }

        // Output to terminal
        if (term) {
            // Auto-switch to SSH view to show result
            const sshTabBtn = document.querySelector('.tab-btn[data-target="ssh-view"]');
            if(sshTabBtn && !sshTabBtn.classList.contains('active')) {
                sshTabBtn.click();
            }
            term.write(outputMessage);
        }

    } catch (e) {
        if (term) {
            term.write("\r\n\x1b[31m[IDE] Error invoking upload: " + e + "\x1b[0m\r\n");
        }
        showToast("Error invoking upload: " + e, "error");
    } finally {
        deployBtn.textContent = originalText;
        deployBtn.disabled = false;
        
        // Fix for space key issue: Remove focus from the button
        deployBtn.blur();
        document.body.focus(); // Explicitly move focus to body first

        // Restore focus to the appropriate view with increased delay
        setTimeout(() => {
            if (document.getElementById('ssh-view').classList.contains('active') && term) {
                term.focus();
                // Ensure xterm internal textarea gets focus if accessible
                if(term.textarea) term.textarea.focus();
            } else if (document.getElementById('editor-view').classList.contains('active') && cmEditor) {
                cmEditor.focus();
            }
        }, 200);
    }
}

function validateMethodNameFormat(name) {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function checkNameValidation(name, id) {
    if (!validateMethodNameFormat(name)) {
        methodNameInput.classList.add('invalid');
        methodNameError.textContent = "Invalid name: Use letters, numbers, and underscores (start with a letter).";
        methodNameError.classList.remove('hidden');
        return false;
    }
    const isDuplicate = methods.some(m => m.name === name && m.id !== id);
    if (isDuplicate) {
        methodNameInput.classList.add('invalid');
        methodNameError.textContent = "Error: Method name already exists.";
        methodNameError.classList.remove('hidden');
        return false;
    }
    methodNameInput.classList.remove('invalid');
    methodNameError.classList.add('hidden');
    return true;
}

function updateUIHeaders() {
    previewFilename.textContent = `Preview: ${objectName}`;
    previewAclname.textContent = `Preview: ${aclName}.json`;
    updateTestCommand();
}

function saveState() {
    localStorage.setItem('ubus_server_maker_methods', JSON.stringify(methods));
    localStorage.setItem('ubus_server_maker_objname', objectName);
    localStorage.setItem('ubus_server_maker_aclname', aclName);
    localStorage.setItem('ubus_server_maker_acldesc', aclDesc);
    localStorage.setItem('ubus_server_maker_chat_sessions', JSON.stringify(chatSessions));
    localStorage.setItem('ubus_server_maker_current_session', currentSessionId);
}

function loadState() {
    const savedMethods = localStorage.getItem('ubus_server_maker_methods');
    const savedObjName = localStorage.getItem('ubus_server_maker_objname');
    const savedAclName = localStorage.getItem('ubus_server_maker_aclname');
    const savedAclDesc = localStorage.getItem('ubus_server_maker_acldesc');
    const savedSessions = localStorage.getItem('ubus_server_maker_chat_sessions');
    const savedCurrentSessionId = localStorage.getItem('ubus_server_maker_current_session');

    if (savedMethods) {
        try { methods = JSON.parse(savedMethods); if (methods.length > 0) selectedId = methods[0].id; } catch(e) {}
    }
    if (savedObjName) { objectName = savedObjName; objectNameInput.value = objectName; }
    if (savedAclName) { aclName = savedAclName; aclNameInput.value = aclName; }
    if (savedAclDesc) { aclDesc = savedAclDesc; aclDescInput.value = aclDesc; }
    
    if (savedSessions) {
        try {
            chatSessions = JSON.parse(savedSessions);
            // Handle 'null' string from localStorage
            currentSessionId = (savedCurrentSessionId === 'null') ? null : savedCurrentSessionId;
            
            const session = chatSessions.find(s => s.id === currentSessionId);
            if (session) {
                chatHistory = session.messages;
            } else {
                // If ID is null or not found, start in draft mode
                startNewChat();
            }
            renderSessionList();
            renderChatHistory();
        } catch(e) { 
            console.error("Failed to load chat history", e); 
            startNewChat();
        }
    } else {
        startNewChat();
    }
}

function renderChatHistory() {
    const historyContainer = document.getElementById('chat-history');
    historyContainer.innerHTML = '';

    chatHistory.forEach(msg => {
        if (msg.role === 'user') {
            appendMessage('user', msg.text);
        } else if (msg.role === 'model') {
            if (msg.text) {
                // Check if it's a tool execution log (starts with [Tool)
                if (msg.text.startsWith('[Tool')) {
                    // Try to parse tool name and result roughly
                    const match = msg.text.match(/^\[Tool (Execution|Error): (.*?)\] (.*)/);
                    if (match) {
                        const isError = match[1] === 'Error';
                        const toolName = match[2];
                        const result = match[3];
                        appendToolMessage(toolName, result, !isError);
                    } else {
                        appendMessage('model', msg.text);
                    }
                } else {
                    appendMessage('model', msg.text);
                }
            }
            // Ignore structured parts (Function Calls) as they are internal history
        }
    });
    
    historyContainer.scrollTop = historyContainer.scrollHeight;
}

function resetData() {
    showConfirm("Reset all data? This cannot be undone.", () => {
        methods = JSON.parse(JSON.stringify(DEFAULT_METHODS));
        objectName = "my_server";
        aclName = "sample";
        aclDesc = "Sample ubus method";
        selectedId = 1;
        
        // Reset Chat
        chatSessions = [];
        currentSessionId = null;
        chatHistory = [];
        
        saveState();
        location.reload();
    });
}

function insertSnippet(text) {
    const doc = cmEditor.getDoc();
    const cursor = doc.getCursor();
    const line = cursor.line;
    // Insert at beginning of line
    const textToInsert = text + '\n';
    doc.replaceRange(textToInsert, {line: line, ch: 0});
    // Move cursor down
    doc.setCursor({line: line + 1, ch: 0});
    cmEditor.focus();
}

function renderMethodList() {
    methodListEl.innerHTML = '';
    methods.forEach(m => {
        const li = document.createElement('li');
        const isValidFormat = validateMethodNameFormat(m.name);
        const isDuplicate = methods.some(other => other.name === m.name && other.id !== m.id);
        const isValid = isValidFormat && !isDuplicate;

        li.className = `nav-item ${m.id === selectedId ? 'active' : ''}`;
        li.style.color = isValid ? '' : 'var(--error-red)';
        
        let label = m.name;
        if (!isValidFormat) label += ' (Invalid)';
        else if (isDuplicate) label += ' (Duplicate)';
        
        li.textContent = label;
        li.onclick = () => { selectedId = m.id; renderMethodList(); renderEditor(); updateTestCommand(); };
        methodListEl.appendChild(li);
    });
}

function renderEditor() {
    const method = methods.find(m => m.id === selectedId);
    if (!method) { editorEmpty.classList.remove('hidden'); editorContent.classList.add('hidden'); return; }
    editorEmpty.classList.add('hidden'); editorContent.classList.remove('hidden');

    methodNameInput.value = method.name;
    
    // Update CodeMirror value without triggering change event loop if possible,
    // but here we just set it.
    if (cmEditor.getValue() !== method.code) {
        cmEditor.setValue(method.code);
    }
    
    modeToggle.checked = (method.mode === 'auto');
    updateHelpText(method.mode);
    aclPermRadios.forEach(r => r.checked = (r.value === method.acl));
    
    checkNameValidation(method.name, method.id);
    renderArgs(method);
    
    // Refresh CM after visibility change
    setTimeout(() => {
        cmEditor.refresh();
        // cmEditor.focus(); // Optional: Decide if we want to steal focus on list click. 
        // User feedback suggests "key input stops working", implying they expect to type.
        // So let's focus it.
        if (!document.activeElement || document.activeElement === document.body || document.activeElement.classList.contains('nav-item')) {
             cmEditor.focus();
        }
    }, 10);
}

function updateHelpText(mode) {
    if (mode === 'auto') { codeHelpAuto.classList.remove('hidden'); codeHelpManual.classList.add('hidden'); } 
    else { codeHelpAuto.classList.add('hidden'); codeHelpManual.classList.remove('hidden'); }
}

function renderArgs(method) {
    argsContainer.innerHTML = '';
    method.args.forEach((arg, index) => {
        const row = document.createElement('div');
        row.className = 'arg-row';
        row.innerHTML = `<input type="text" value="${arg.name}" placeholder="Arg Name" oninput="updateArg(${method.id}, ${index}, 'name', this.value)">
            <select onchange="updateArg(${method.id}, ${index}, 'type', this.value)">
                <option value="string" ${arg.type==='string'?'selected':''}>String</option>
                <option value="number" ${arg.type==='number'?'selected':''}>Number</option>
                <option value="boolean" ${arg.type==='boolean'?'selected':''}>Boolean</option>
                <option value="table" ${arg.type==='table'?'selected':''}>Table</option>
            </select>
            <button class="btn small secondary" onclick="removeArg(${method.id}, ${index})">X</button>`;
        argsContainer.appendChild(row);
    });
}

function updateSelectedMethod(field, value) {
    const method = methods.find(m => m.id === selectedId);
    if (method) {
        if (field === 'name') {
            checkNameValidation(value, method.id);
            renderMethodList();
        }
        if (field === 'mode' && value === 'manual' && method.mode === 'auto') {
            method.code = `local r = {}
local response = {}
${method.code}
r.result = jsonc.stringify(response, false)
return r`;
            if (cmEditor) cmEditor.setValue(method.code);
        }
        method[field] = value;
        saveState();
        updatePreviews();
        updateTestCommand();
    }
}

function addMethod() {
    const newId = methods.length > 0 ? Math.max(...methods.map(m => m.id)) + 1 : 1;
    let nameBase = "new_method";
    let count = newId;
    let name = `${nameBase}_${count}`;
    while (methods.some(m => m.name === name)) {
        count++;
        name = `${nameBase}_${count}`;
    }

    methods.push({ id: newId, name: name, args: [], mode: 'auto', acl: 'read', code: `response.contents = "New Method"` });
    selectedId = newId;
    saveState(); renderMethodList(); renderEditor(); updatePreviews(); updateTestCommand();
}

function deleteMethod() {
    showConfirm('Delete this method?', () => {
        methods = methods.filter(m => m.id !== selectedId);
        selectedId = methods.length > 0 ? methods[0].id : null;
        saveState(); renderMethodList(); renderEditor(); updatePreviews(); updateUIHeaders();
    });
}

function addArg() {
    const method = methods.find(m => m.id === selectedId);
    if (method) { method.args.push({ name: 'arg', type: 'string' }); renderArgs(method); updatePreviews(); updateTestCommand(); }
}

function updateArg(methodId, index, field, value) {
    const method = methods.find(m => m.id === methodId);
    if (method && method.args[index]) { method.args[index][field] = value; updatePreviews(); updateTestCommand(); }
}

function removeArg(methodId, index) {
    const method = methods.find(m => m.id === methodId);
    if (method) { method.args.splice(index, 1); renderArgs(method); updatePreviews(); updateTestCommand(); }
}

function updatePreviews() {
    let lua = LUA_HEADER;
    methods.forEach((m, idx) => {
        let args = "";
        if (m.args.length > 0) {
            args = `
        args = {
${m.args.map(a => `            ${a.name} = ${a.type==='number'?'123':a.type==='boolean'?'true':a.type==='table'?'{}':'"a_string"'}`).join(',\n')}
        },`;
        }
        let body = m.mode === 'auto' ? `            local response = {}
${m.code.split('\n').map(l=>'            '+l).join('\n')}
            local r = {}
            r.result = jsonc.stringify(response, false)
            return r` : m.code.split('\n').map(l=>'            '+l).join('\n');
        lua += `    ${m.name} = {${args}
        call = function(args)
${body}
        end
    }${idx < methods.length - 1 ? ',' : ''}
`;
    });
    luaPreview.textContent = lua + LUA_FOOTER;

    const read = methods.filter(m => m.acl === 'read').map(m => m.name);
    const write = methods.filter(m => m.acl === 'write').map(m => m.name);
    aclPreview.textContent = JSON.stringify({ [aclName]: { description: aclDesc, read: { ubus: { [objectName]: read } }, write: { ubus: { [objectName]: write } } } }, null, 4);
}

function updateTestCommand() {
    const method = methods.find(m => m.id === selectedId);
    if (!method) { testCommandCode.textContent = "Select a method"; return; }
    let args = {}; method.args.forEach(a => { args[a.name] = a.type==='number'?123:a.type==='boolean'?true:a.type==='table'?{}:"val"; });
    testCommandCode.textContent = `ubus call ${objectName} ${method.name} '${JSON.stringify(args)}'`;
}

function copyTestCommand() {
    navigator.clipboard.writeText(testCommandCode.textContent).then(() => {
        const old = copyCmdBtn.textContent; copyCmdBtn.textContent = "Copied!"; setTimeout(() => copyCmdBtn.textContent = old, 2000);
    });
}

function downloadLua() {
    const blob = new Blob([luaPreview.textContent], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = objectName; a.click();
}

function downloadAcl() {
    const blob = new Blob([aclPreview.textContent], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${aclName}.json`; a.click();
}

let term;
let fitAddon;

function initTerminal() {
    // xterm.js Init
    term = new Terminal({
        cursorBlink: true,
        theme: {
            background: '#000000',
            foreground: '#ffffff'
        },
        fontFamily: 'Fira Code, monospace',
        fontSize: 14
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    
    const container = document.getElementById('terminal-container');
    term.open(container);
    fitAddon.fit();

    // Ensure terminal gets focus when container is clicked
    container.addEventListener('click', () => {
        if (term) term.focus();
    });

    // Resize Event
    window.addEventListener('resize', () => {
        if(document.getElementById('ssh-view').classList.contains('active')){
            fitAddon.fit();
            window.electronAPI.resizeSSH({ cols: term.cols, rows: term.rows });
        }
    });

    // Input Event
    term.onData(data => {
        window.electronAPI.sendSSHInput(data);
    });

    // Receive Data
    window.electronAPI.onSSHData((data) => {
        term.write(data);
    });

    window.electronAPI.onSSHStatus((status) => {
        const statusEl = document.getElementById('ssh-status');
        const connectBtn = document.getElementById('ssh-connect-btn');
        
        statusEl.textContent = status;
        
        if (status === 'Connected') {
            statusEl.style.color = '#4caf50'; // Green
            connectBtn.disabled = true;
            term.focus();
            fitAddon.fit();
            window.electronAPI.resizeSSH({ cols: term.cols, rows: term.rows });
        } else if (status === 'Disconnected') {
            statusEl.style.color = '#666';
            connectBtn.disabled = false;
        } else {
            statusEl.style.color = '#f44336'; // Red
            connectBtn.disabled = false;
        }
    });

    window.electronAPI.onSSHError((err) => {
        term.write('\r\n\x1b[31m' + err + '\x1b[0m\r\n');
    });

    // Connect Button
    document.getElementById('ssh-connect-btn').addEventListener('click', async () => {
        const host = document.getElementById('deploy-host').value;
        const user = document.getElementById('deploy-user').value;
        const pass = document.getElementById('deploy-pass').value;

        if (!host || !user) {
            showToast('Host and Username are required in Settings sidebar.', 'error');
            return;
        }

        term.clear();
        term.write(`Connecting to ${user}@${host}...\r\n`);
        
        try {
            await window.electronAPI.connectSSH({
                host: host,
                username: user,
                password: pass
            });
        } catch (err) {
            showToast('Connection Failed: ' + err.message, 'error');
        }
    });
}

// --- Gemini Chat Logic ---
let chatHistory = [];
let chatSessions = [];
let currentSessionId = null;

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function startNewChat() {
    // Reset state to "draft" mode - session created on first message
    currentSessionId = null;
    chatHistory = [];
    
    // Clear UI
    renderChatHistory();
    renderSessionList(); // Updates active state (none selected)
    
    saveState(); // Persist the "draft" state so reload doesn't bring back old session

    // Auto-switch to chat view
    document.getElementById('chat-history-view').classList.add('hidden');
    document.getElementById('chat-main-view').classList.remove('hidden');
}

function switchSession(sessionId) {
    const session = chatSessions.find(s => s.id === sessionId);
    if (session) {
        currentSessionId = sessionId;
        chatHistory = session.messages;
        renderSessionList();
        renderChatHistory();
        // Auto-switch to chat view
        document.getElementById('chat-history-view').classList.add('hidden');
        document.getElementById('chat-main-view').classList.remove('hidden');
    }
}

function renderSessionList() {
    const listEl = document.getElementById('session-list');
    listEl.innerHTML = '';
    
    chatSessions.forEach(session => {
        const item = document.createElement('div');
        item.className = `session-item ${session.id === currentSessionId ? 'active' : ''}`;
        
        const titleDiv = document.createElement('div');
        titleDiv.textContent = session.title;
        titleDiv.style.fontWeight = 'bold';
        
        const dateSpan = document.createElement('span');
        dateSpan.className = 'date';
        dateSpan.textContent = new Date(session.timestamp).toLocaleString();
        
        item.appendChild(titleDiv);
        item.appendChild(dateSpan);
        
        item.onclick = () => switchSession(session.id);
        listEl.appendChild(item);
    });
}

const DEFAULT_SYSTEM_MESSAGE = `You are an expert developer specializing in OpenWrt, Lua, and the UBUS (micro bus) architecture.
Your goal is to assist the user in generating correct, efficient, and secure Lua scripts for UBUS methods.

Key constraints and context:
1.  **Environment**: The scripts run on OpenWrt routers using the standard Lua interpreter (Lua 5.1 compatible).
2.  **Libraries**:
    -   Use \`luci.jsonc\` for JSON handling.
    -   Use \`luci.model.uci\` for configuration management (Unified Configuration Interface).
    -   Use \`nixio.fs\` for file system operations.
    -   Use \`luci.sys\` for system calls.
    -   Use \`ubus\` for interacting with other UBUS objects.
3.  **Code Structure**:
    -   The user is editing the *body* of a specific UBUS method function.
    -   In "Auto Mode" (default), the variable \`response\` (table) is pre-defined. You must assign values to \`response\`. Do not return anything; the wrapper handles it.
    -   In "Manual Mode", the user controls the entire function body and must return a table with \`result\`.
4.  **Security**: Always validate inputs. Be cautious with \`os.execute\` to avoid injection vulnerabilities.
5.  **Output**: When asked for code, provide *only* the Lua code block for the function body unless asked for full file context.

Maintain a helpful, concise, and technical tone.`;

if (window.electronAPI) {
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-chat-btn');
    const newChatBtn = document.getElementById('new-chat-btn');
    const historyContainer = document.getElementById('chat-history');
    const settingsBtn = document.getElementById('gemini-settings-btn');
    const settingsPanel = document.getElementById('gemini-settings-panel');
    const saveConfigBtn = document.getElementById('save-gemini-config-btn');
    const apiKeyInput = document.getElementById('gemini-api-key');
    const modelSelect = document.getElementById('gemini-model');
    const systemMessageInput = document.getElementById('gemini-system-message');
    
    // Tools Checkboxes
    const toolCheckboxes = {
        'update_editor_code': document.getElementById('tool-update-code'),
        'deploy_to_router': document.getElementById('tool-deploy'),
        'add_new_method': document.getElementById('tool-add-method'),
        'set_object_name': document.getElementById('tool-set-objname'),
        'rename_method': document.getElementById('tool-rename-method'),
        'connect_ssh': document.getElementById('tool-connect-ssh')
    };

    const historyBtn = document.getElementById('gemini-history-btn');
    const historyView = document.getElementById('chat-history-view');
    const mainChatView = document.getElementById('chat-main-view');
    const backToChatBtn = document.getElementById('back-to-chat-btn');

    // Load initial settings
    window.electronAPI.getGeminiConfig().then(config => {
        if(config) {
            apiKeyInput.value = config.apiKey || '';
            modelSelect.value = config.model || 'gemini-1.5-flash';
            systemMessageInput.value = config.systemMessage || DEFAULT_SYSTEM_MESSAGE;
            
            // Load tool settings
            const enabledTools = config.enabledTools || {};
            for (const [name, cb] of Object.entries(toolCheckboxes)) {
                if (cb) {
                    // Default to true if not specified
                    cb.checked = enabledTools[name] !== false;
                }
            }
        } else {
            systemMessageInput.value = DEFAULT_SYSTEM_MESSAGE;
        }
    });

    historyBtn.addEventListener('click', () => {
        historyView.classList.remove('hidden');
        mainChatView.classList.add('hidden');
        settingsPanel.classList.add('hidden'); // Ensure settings are closed
    });

    backToChatBtn.addEventListener('click', () => {
        historyView.classList.add('hidden');
        mainChatView.classList.remove('hidden');
    });

    newChatBtn.addEventListener('click', () => {
        startNewChat();
        showToast("New chat started.", "info");
    });

    settingsBtn.addEventListener('click', () => {
        settingsPanel.classList.toggle('hidden');
    });

    saveConfigBtn.addEventListener('click', async () => {
        const enabledTools = {};
        for (const [name, cb] of Object.entries(toolCheckboxes)) {
            if (cb) {
                enabledTools[name] = cb.checked;
            }
        }

        const config = {
            apiKey: apiKeyInput.value,
            model: modelSelect.value,
            systemMessage: systemMessageInput.value,
            enabledTools: enabledTools
        };
        await window.electronAPI.saveGeminiConfig(config);
        showToast('Gemini settings saved.', 'success');
        settingsPanel.classList.add('hidden');
    });

    function appendMessage(role, text) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `chat-message ${role}`;
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        
        if (typeof marked !== 'undefined') {
            // Render as Markdown
            contentDiv.innerHTML = marked.parse(text);
        } else {
            // Fallback to plain text
            contentDiv.textContent = text;
        }

        msgDiv.appendChild(contentDiv);
        historyContainer.appendChild(msgDiv);
        historyContainer.scrollTop = historyContainer.scrollHeight;
    }

    function appendToolMessage(toolName, resultMessage, isSuccess = true) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `chat-message tool`;
        
        const cardDiv = document.createElement('div');
        cardDiv.className = 'tool-usage-card';
        
        const headerDiv = document.createElement('div');
        headerDiv.className = 'tool-header';
        headerDiv.innerHTML = `<span class="tool-icon">⚡</span> <span class="tool-name">Function Call: ${toolName}</span>`;
        
        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'tool-body';
        
        if (isSuccess) {
            bodyDiv.innerHTML = `<div class="tool-success"><span>✔</span> ${resultMessage}</div>`;
        } else {
            bodyDiv.innerHTML = `<div class="tool-error"><span>✖</span> ${resultMessage}</div>`;
        }
        
        cardDiv.appendChild(headerDiv);
        cardDiv.appendChild(bodyDiv);
        msgDiv.appendChild(cardDiv);
        
        historyContainer.appendChild(msgDiv);
        historyContainer.scrollTop = historyContainer.scrollHeight;
    }

    function ensureEditorViewVisible() {
        const editorTabBtn = document.querySelector('.tab-btn[data-target="editor-view"]');
        if (editorTabBtn && !editorTabBtn.classList.contains('active')) {
            editorTabBtn.click();
        }
    }

    function ensureSSHViewVisible() {
        const sshTabBtn = document.querySelector('.tab-btn[data-target="ssh-view"]');
        if (sshTabBtn && !sshTabBtn.classList.contains('active')) {
            sshTabBtn.click();
        }
    }

    let isSending = false;

    async function sendMessage(userText = null, toolResponseData = null) {
        // Prevent double submission for user messages
        if (userText && isSending) return;

        // If it's a new user message
        if (userText) {
            const text = userText.trim();
            if (!text) return;
            
            // Lazy Session Creation: Create session only on first message
            if (currentSessionId === null) {
                const newSession = {
                    id: generateUUID(),
                    title: text.length > 20 ? text.substring(0, 20) + "..." : text,
                    messages: [],
                    timestamp: Date.now()
                };
                chatSessions.unshift(newSession);
                currentSessionId = newSession.id;
                chatHistory = newSession.messages; // Link reference
                
                // Request AI generated title asynchronously
                // Note: We don't await this to keep the chat responsive
                window.electronAPI.chatWithGemini({
                    message: `Generate a very short title (max 5 words) summarizing this user request: "${text}"`,
                    history: [], // No history
                    systemMessage: "You are a helpful assistant that generates short, concise titles for chat sessions. Do not use quotes.",
                    disableTools: true
                }).then(result => {
                    if (result.success && result.text) {
                        newSession.title = result.text.trim().replace(/^["']|["']$/g, '');
                        saveState();
                        renderSessionList();
                    }
                }).catch(err => console.error("Failed to generate title", err));

                renderSessionList();
                saveState();
            }

            appendMessage('user', text);
            chatInput.value = '';
            chatHistory.push({ role: 'user', text: text });
        }

        // If it's a tool response (recursion)
        if (toolResponseData) {
            // Add function response to history
            chatHistory.push({
                role: 'function',
                parts: [{
                    functionResponse: {
                        name: toolResponseData.name,
                        response: { name: toolResponseData.name, content: toolResponseData.result }
                    }
                }]
            });
        }

        isSending = true;
        chatInput.disabled = true;
        sendBtn.classList.add('loading');

        try {
            // If sending a tool response, message is empty (history contains the info)
            const result = await window.electronAPI.chatWithGemini({
                message: userText ? userText : null,
                history: userText ? chatHistory.slice(0, -1) : chatHistory
            });

            if (result.success) {
                // 1. Show text response first if available
                if (result.text) {
                    appendMessage('model', result.text);
                    chatHistory.push({ role: 'model', text: result.text });
                }

                // 2. Handle Function Call
                if (result.functionCall) {
                    const fc = result.functionCall;
                    const args = fc.args || {};
                    let msg = "";
                    let isSuccess = true;

                    // Add the Function Call itself to history so the next turn (response) makes sense
                    chatHistory.push({
                        role: 'model',
                        parts: [{ functionCall: fc }]
                    });

                    try {
                        if (fc.name === 'update_editor_code') {
                            if (args.code) {
                                if (cmEditor) {
                                    cmEditor.setValue(args.code);
                                    updateSelectedMethod('code', args.code);
                                }
                                ensureEditorViewVisible(); // Switch to editor
                                msg = `Updated editor code with ${args.code.length} characters.`;
                            }
                        } else if (fc.name === 'deploy_to_router') {
                            // Trigger deploy button logic
                            handleDeploy(); 
                            msg = `Triggered deployment process to ${deployHostInput.value}.`;
                        } else if (fc.name === 'add_new_method') {
                            addMethod();
                            if (args.name) {
                                // Rename the newly added method (last one)
                                const newMethod = methods[methods.length - 1];
                                newMethod.name = args.name;
                                updateSelectedMethod('name', args.name);
                                msg = `Added new method: ${args.name}`;
                            } else {
                                msg = `Added new method.`;
                            }
                            ensureEditorViewVisible(); // Switch to editor
                        } else if (fc.name === 'set_object_name') {
                            if (args.name) {
                                objectNameInput.value = args.name;
                                objectName = args.name;
                                saveState();
                                updateUIHeaders();
                                updateTestCommand();
                                updatePreviews();
                                msg = `Set object name to: ${args.name}`;
                            }
                        } else if (fc.name === 'rename_method') {
                            const oldName = args.old_name;
                            const newName = args.new_name;
                            const targetMethod = methods.find(m => m.name === oldName);
                            
                            if (targetMethod) {
                                // Check for duplicates
                                if (methods.some(m => m.name === newName && m.id !== targetMethod.id)) {
                                    throw new Error(`Method name "${newName}" already exists.`);
                                }
                                
                                targetMethod.name = newName;
                                selectedId = targetMethod.id; // Select the renamed method
                                updateSelectedMethod('name', newName); // This handles UI updates and saving
                                ensureEditorViewVisible();
                                msg = `Renamed method "${oldName}" to "${newName}".`;
                            } else {
                                throw new Error(`Method "${oldName}" not found.`);
                            }
                        } else if (fc.name === 'connect_ssh') {
                            const host = deployHostInput.value;
                            const user = deployUserInput.value;
                            const pass = deployPassInput.value;

                            if (!host || !user) {
                                throw new Error("Host IP and Username are required in Settings to connect.");
                            }

                            try {
                                // Trigger SSH connection (async process handled by main)
                                await window.electronAPI.connectSSH({
                                    host: host,
                                    username: user,
                                    password: pass
                                });
                                ensureSSHViewVisible();
                                msg = `Successfully connected to ${user}@${host}.`;
                            } catch (err) {
                                isSuccess = false;
                                msg = `Failed to connect to ${user}@${host}: ${err.message}`;
                            }
                        } else {
                            msg = `Unknown tool called: ${fc.name}`;
                            isSuccess = false;
                        }

                        appendToolMessage(fc.name, msg, isSuccess);
                        
                        // RECURSION: Send the tool result back to Gemini
                        // This allows the AI to see the result and generate a final confirmation message.
                        await sendMessage(null, { name: fc.name, result: msg });

                    } catch (e) {
                        appendToolMessage(fc.name, `Error: ${e.message}`, false);
                        // Even on error, we should probably report it back to AI?
                        // For now, let's just log it to history as text to avoid complex error handling loops
                        chatHistory.push({ role: 'model', text: `[Tool Error: ${fc.name}] ${e.message}` });
                    }
                }
            } else {
                appendMessage('model', 'Error: ' + result.error);
            }
        } catch (error) {
            appendMessage('model', 'Network/IPC Error: ' + error.message);
        } finally {
            isSending = false;
            chatInput.disabled = false;
            sendBtn.classList.remove('loading');
            if (!toolResponseData) chatInput.focus(); // Only focus if it was a user interaction
        }
    }

    sendBtn.addEventListener('click', () => {
        if(!isSending) sendMessage(chatInput.value);
    });
    
    chatInput.addEventListener('keydown', (e) => {
        // Fix for IME duplication: check e.isComposing
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            if(!isSending) sendMessage(chatInput.value);
        }
    });
}

init();
