const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { NodeSSH } = require('node-ssh');
const { Client } = require('ssh2');
// const { GoogleGenerativeAI } = require("@google/generative-ai"); // Removed SDK
const fs = require('fs');
const os = require('os');

const store = new Store();
// const ssh = new NodeSSH(); // Removed global instance

// Helper to write content to a remote file using 'cat' via SSH stream
// This avoids dependency on SFTP server on the remote host.
async function uploadContent(sshInstance, content, remotePath) {
    const safeRemotePath = `"${remotePath.replace(/"/g, '\\"')}"`;

    return new Promise((resolve, reject) => {
        sshInstance.connection.exec(`cat > ${safeRemotePath}`, (err, stream) => {
            if (err) return reject(err);

            stream.on('close', (code, signal) => {
                if (code === 0) resolve();
                else reject(new Error(`Remote write failed with exit code ${code}`));
            });

            stream.on('data', () => {}); // Ignore stdout
            stream.stderr.on('data', (data) => console.error(`Remote stderr: ${data}`));

            stream.write(content);
            stream.end();
        });
    });
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    win.loadFile('index.html');
    // win.webContents.openDevTools(); // デバッグ時に有効化
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (sshConn) {
        try {
            sshConn.end();
        } catch (e) { /* ignore */ }
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    if (sshConn) {
        try {
            sshConn.end();
            sshConn.destroy();
        } catch (e) { /* ignore */ }
    }
});

// --- IPC Handlers ---

// Gemini Config
ipcMain.handle('save-gemini-config', async (event, config) => {
    store.set('geminiConfig', config);
    return { success: true };
});

ipcMain.handle('get-gemini-config', async () => {
    return store.get('geminiConfig', { apiKey: '', model: 'gemini-1.5-flash' });
});

// Tool Definitions
const ALL_TOOLS = [
    {
        name: "update_editor_code",
        description: "Updates the main code editor with the provided Lua script. Use this tool when you generate or modify Lua code for the user.",
        parameters: {
            type: "object",
            properties: {
                code: { type: "string", description: "The complete Lua source code to write to the editor." }
            },
            required: ["code"]
        }
    },
    {
        name: "deploy_to_router",
        description: "Deploys (uploads) the current script and ACL to the configured OpenWrt router via SCP and restarts RPCD.",
        parameters: {
            type: "object",
            properties: {}, // No params needed
        }
    },
    {
        name: "add_new_method",
        description: "Adds a new UBUS method to the list. Use this when the user wants to create a new functionality.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "The name of the new method (optional)." }
            },
        }
    },
    {
        name: "set_object_name",
        description: "Sets the UBUS object name (namespace).",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "The new object name." }
            },
            required: ["name"]
        }
    },
    {
        name: "rename_method",
        description: "Renames an existing UBUS method.",
        parameters: {
            type: "object",
            properties: {
                old_name: { type: "string", description: "The current name of the method to rename." },
                new_name: { type: "string", description: "The new name for the method." }
            },
            required: ["old_name", "new_name"]
        }
    },
    {
        name: "connect_ssh",
        description: "Initiates an SSH connection to the router using the saved credentials.",
        parameters: {
            type: "object",
            properties: {},
        }
    }
];

ipcMain.handle('chat-with-gemini', async (event, { message, history, systemMessage, disableTools }) => {
    try {
        const config = store.get('geminiConfig');
        if (!config || !config.apiKey) {
            throw new Error("API Key is missing. Please set it in Settings.");
        }

        const modelName = config.model || "gemini-1.5-flash";
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${config.apiKey}`;

        // Construct request body for REST API
        // Support both simple text history and structured history (for function calls)
        const contents = history.map(h => {
            if (h.parts) {
                return { role: h.role, parts: h.parts };
            }
            return {
                role: h.role === 'user' ? 'user' : 'model',
                parts: [{ text: h.text }]
            };
        });

        // Add the new user message if provided
        if (message) {
            contents.push({
                role: 'user',
                parts: [{ text: message }]
            });
        }

        const requestBody = {
            contents: contents
        };

        if (!disableTools) {
            // Filter Tools
            const enabledTools = [];
            const toolConfig = config.enabledTools || { 
                'update_editor_code': true, 
                'deploy_to_router': true, 
                'add_new_method': true, 
                'set_object_name': true,
                'rename_method': true,
                'connect_ssh': true
            };

            ALL_TOOLS.forEach(tool => {
                if (toolConfig[tool.name]) {
                    enabledTools.push({
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters
                    });
                }
            });

            if (enabledTools.length > 0) {
                requestBody.tools = [{ function_declarations: enabledTools }];
            }
        }

        // Use custom system message if provided, otherwise use config
        if (systemMessage) {
            requestBody.systemInstruction = {
                parts: [{ text: systemMessage }]
            };
        } else if (config.systemMessage) {
            requestBody.systemInstruction = {
                parts: [{ text: config.systemMessage }]
            };
        }

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Gemini API Error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        
        // Extract content
        const candidate = data.candidates?.[0];
        const parts = candidate?.content?.parts;

        if (!parts || parts.length === 0) {
            throw new Error("No content in API response.");
        }

        // Check for function call
        const functionCall = parts.find(part => part.functionCall);
        const textPart = parts.find(part => part.text);

        if (functionCall) {
            return {
                success: true,
                functionCall: functionCall.functionCall,
                text: textPart ? textPart.text : null // Optional accompanying text
            };
        }

        const text = textPart?.text;
        
        if (!text) {
            throw new Error("No text content in API response.");
        }

        return { success: true, text: text };

    } catch (error) {
        console.error("Gemini Chat Error:", error);
        return { success: false, error: error.message };
    }
});

// 設定の保存
ipcMain.handle('save-settings', async (event, settings) => {
    store.set('deploySettings', settings);
    return { success: true };
});

// 設定の読み込み
ipcMain.handle('get-settings', async () => {
    return store.get('deploySettings', {
        host: '192.168.1.1',
        username: 'root',
        password: '',
        scriptPath: '/usr/libexec/rpcd/',
        aclPath: '/usr/share/rpcd/acl.d/'
    });
});

// SCPアップロード実行
ipcMain.handle('deploy-files', async (event, { connection, files }) => {
    const sshClient = new NodeSSH();
    try {
        await sshClient.connect({
            host: connection.host,
            username: connection.username,
            password: connection.password,
            // privateKeyPath: connection.privateKey // 必要であれば拡張
        });

        const results = [];

        // Luaスクリプトのアップロード
        if (files.lua && files.lua.content) {
            const remotePath = path.posix.join(connection.scriptPath, files.lua.filename);
            await uploadContent(sshClient, files.lua.content, remotePath);
            await sshClient.execCommand(`chmod +x ${remotePath}`); // 実行権限付与
            results.push(`Uploaded & chmod +x: ${remotePath}`);
        }

        // ACL JSONのアップロード
        if (files.acl && files.acl.content) {
            const remotePath = path.posix.join(connection.aclPath, files.acl.filename);
            await uploadContent(sshClient, files.acl.content, remotePath);
            results.push(`Uploaded: ${remotePath}`);
        }

        // RPCDの再起動
        await sshClient.execCommand('/etc/init.d/rpcd restart'); 
        results.push('Executed: /etc/init.d/rpcd restart');

        sshClient.dispose();
        return { success: true, messages: results };

    } catch (error) {
        if (sshClient.isConnected()) sshClient.dispose();
        console.error('Deploy error:', error);
        return { success: false, error: error.message };
    }
});

// --- SSH Terminal Handlers ---
let sshConn = null;
let sshStream = null;

ipcMain.handle('ssh-connect', async (event, config) => {
    return new Promise((resolve, reject) => {
        if (sshConn) {
            sshConn.end();
        }
        sshConn = new Client();
        
        sshConn.on('ready', () => {
            if (!event.sender.isDestroyed()) event.sender.send('ssh-status', 'Connected');
            // Start shell (PTY)
            sshConn.shell({ term: 'xterm-256color' }, (err, stream) => {
                if (err) {
                    if (!event.sender.isDestroyed()) event.sender.send('ssh-error', 'Shell Error: ' + err.message);
                    return;
                }
                sshStream = stream;

                // Send data to frontend
                stream.on('data', (data) => {
                    if (!event.sender.isDestroyed()) event.sender.send('ssh-data', data.toString());
                });

                stream.on('close', () => {
                    if (sshConn) sshConn.end();
                    if (!event.sender.isDestroyed()) event.sender.send('ssh-status', 'Disconnected');
                });
            });
            resolve({ success: true });
        }).on('error', (err) => {
            if (!event.sender.isDestroyed()) {
                event.sender.send('ssh-error', 'Connection Error: ' + err.message);
                event.sender.send('ssh-status', 'Error');
            }
            reject(new Error(err.message));
        }).on('end', () => {
            if (!event.sender.isDestroyed()) event.sender.send('ssh-status', 'Disconnected');
        }).connect({
            host: config.host,
            username: config.username,
            password: config.password,
            readyTimeout: 20000
        });
    });
});

ipcMain.on('ssh-input', (event, data) => {
    if (sshStream) {
        sshStream.write(data);
    }
});

ipcMain.on('ssh-resize', (event, { cols, rows }) => {
    if (sshStream) {
        sshStream.setWindow(rows, cols, 0, 0);
    }
});

ipcMain.on('ssh-disconnect', () => {
    if (sshConn) {
        sshConn.end();
        sshConn = null;
        sshStream = null;
    }
});
