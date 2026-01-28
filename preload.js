const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    deployFiles: (data) => ipcRenderer.invoke('deploy-files', data),

    // Gemini Chat
    saveGeminiConfig: (config) => ipcRenderer.invoke('save-gemini-config', config),
    getGeminiConfig: () => ipcRenderer.invoke('get-gemini-config'),
    chatWithGemini: (data) => ipcRenderer.invoke('chat-with-gemini', data),

    // SSH Terminal
    connectSSH: (config) => ipcRenderer.invoke('ssh-connect', config),
    sendSSHInput: (data) => ipcRenderer.send('ssh-input', data),
    resizeSSH: (dims) => ipcRenderer.send('ssh-resize', dims),
    
    // RPC
    sendRpcRequest: (url, data) => ipcRenderer.invoke('send-rpc-request', { url, data }),

    // Listeners
    onSSHData: (callback) => ipcRenderer.on('ssh-data', (_event, value) => callback(value)),
    onSSHStatus: (callback) => ipcRenderer.on('ssh-status', (event, status) => callback(status)),
    onSSHError: (callback) => ipcRenderer.on('ssh-error', (event, err) => callback(err))
});
