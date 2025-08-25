// ============================================
// NETWORK MONITOR BACKEND SERVER
// ============================================
// Save this file as: server.js

const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const os = require('os');
const ping = require('ping');
const arp = require('node-arp');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve the HTML file from public folder

// Store discovered devices
let devices = new Map();
let scanInProgress = false;

// ============================================
// NETWORK SCANNING FUNCTIONS
// ============================================

// Get local network information
function getLocalNetwork() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                // Calculate network range from IP and netmask
                const ip = iface.address;
                const netmask = iface.netmask;
                const networkRange = calculateNetworkRange(ip, netmask);
                return { ip, netmask, networkRange };
            }
        }
    }
    return null;
}

// Calculate network range (simplified for /24 networks)
function calculateNetworkRange(ip, netmask) {
    // For simplicity, assuming /24 network
    const ipParts = ip.split('.');
    return `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.0/24`;
}

// Scan network using ARP (works on local network only)
async function scanNetworkARP() {
    const network = getLocalNetwork();
    if (!network) {
        throw new Error('Could not determine local network');
    }

    console.log(`Scanning network: ${network.networkRange}`);
    const baseIP = network.networkRange.split('/')[0].split('.').slice(0, 3).join('.');
    const discoveredDevices = [];

    // Scan IP range (1-254)
    const scanPromises = [];
    for (let i = 1; i <= 254; i++) {
        const ip = `${baseIP}.${i}`;
        scanPromises.push(scanHost(ip));
    }

    const results = await Promise.allSettled(scanPromises);
    results.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
            discoveredDevices.push(result.value);
        }
    });

    return discoveredDevices;
}

// Scan individual host
async function scanHost(ip) {
    try {
        const isAlive = await ping.promise.probe(ip, {
            timeout: 1,
            min_reply: 1
        });

        if (isAlive.alive) {
            // Get MAC address using ARP
            const macAddress = await getMacAddress(ip);
            
            // Get hostname
            const hostname = await getHostname(ip);
            
            // Determine device type (basic heuristic)
            const deviceType = guessDeviceType(ip, hostname, macAddress);
            
            return {
                ip,
                mac: macAddress || 'Unknown',
                hostname: hostname || ip,
                type: deviceType,
                status: 'online',
                lastSeen: new Date(),
                responseTime: isAlive.time || 0
            };
        }
    } catch (error) {
        // Host not reachable
    }
    return null;
}

// Get MAC address for an IP
function getMacAddress(ip) {
    return new Promise((resolve) => {
        arp.getMAC(ip, (err, mac) => {
            resolve(err ? null : mac);
        });
    });
}

// Get hostname for an IP
async function getHostname(ip) {
    try {
        const { stdout } = await execPromise(`nslookup ${ip}`);
        const match = stdout.match(/name = (.+)/i);
        return match ? match[1].trim() : null;
    } catch {
        return null;
    }
}

// Guess device type based on various factors
function guessDeviceType(ip, hostname, mac) {
    const ipParts = ip.split('.');
    const lastOctet = parseInt(ipParts[3]);
    
    // Router usually at .1
    if (lastOctet === 1) return 'Router';
    
    // Check hostname patterns
    if (hostname) {
        const lower = hostname.toLowerCase();
        if (lower.includes('router') || lower.includes('gateway')) return 'Router';
        if (lower.includes('switch')) return 'Switch';
        if (lower.includes('printer')) return 'Printer';
        if (lower.includes('phone') || lower.includes('android') || lower.includes('iphone')) return 'Phone';
        if (lower.includes('tv') || lower.includes('roku') || lower.includes('chromecast')) return 'Smart TV';
        if (lower.includes('camera')) return 'Camera';
        if (lower.includes('server')) return 'Server';
    }
    
    // Check MAC vendor (simplified)
    if (mac) {
        const vendor = mac.substring(0, 8).toUpperCase();
        // Add vendor checks here based on OUI database
    }
    
    // Default based on IP range
    if (lastOctet <= 50) return 'Server';
    if (lastOctet <= 100) return 'Computer';
    return 'Device';
}

// Monitor device performance (simulated for now)
async function getDeviceMetrics(ip) {
    // In production, you would use SNMP or WMI for real metrics
    return {
        cpu: Math.floor(Math.random() * 100),
        memory: Math.floor(Math.random() * 100),
        bandwidth: Math.floor(Math.random() * 1000),
        uptime: Math.floor(Math.random() * 86400)
    };
}

// ============================================
// API ROUTES
// ============================================

// Get network information
app.get('/api/network-info', (req, res) => {
    const network = getLocalNetwork();
    res.json(network);
});

// Scan network
app.post('/api/scan', async (req, res) => {
    if (scanInProgress) {
        return res.status(409).json({ error: 'Scan already in progress' });
    }

    scanInProgress = true;
    
    try {
        const discoveredDevices = await scanNetworkARP();
        
        // Update devices map
        discoveredDevices.forEach(device => {
            devices.set(device.ip, device);
        });
        
        // Broadcast update to WebSocket clients
        broadcastUpdate('scan-complete', Array.from(devices.values()));
        
        res.json({
            success: true,
            devicesFound: discoveredDevices.length,
            devices: discoveredDevices
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        scanInProgress = false;
    }
});

// Get all devices
app.get('/api/devices', (req, res) => {
    res.json(Array.from(devices.values()));
});

// Get device details
app.get('/api/devices/:ip', async (req, res) => {
    const device = devices.get(req.params.ip);
    if (!device) {
        return res.status(404).json({ error: 'Device not found' });
    }
    
    // Get current metrics
    const metrics = await getDeviceMetrics(req.params.ip);
    
    res.json({
        ...device,
        metrics
    });
});

// Ping device
app.post('/api/ping/:ip', async (req, res) => {
    try {
        const result = await ping.promise.probe(req.params.ip, {
            timeout: 2,
            extra: ['-c', '4']
        });
        
        res.json({
            alive: result.alive,
            responseTime: result.time,
            packetLoss: result.packetLoss
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// WEBSOCKET SERVER
// ============================================

const wss = new WebSocket.Server({ port: 3001 });

wss.on('connection', (ws) => {
    console.log('WebSocket client connected');
    
    // Send current devices on connect
    ws.send(JSON.stringify({
        type: 'initial',
        data: Array.from(devices.values())
    }));
    
    ws.on('close', () => {
        console.log('WebSocket client disconnected');
    });
});

function broadcastUpdate(type, data) {
    const message = JSON.stringify({ type, data });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ============================================
// PERIODIC MONITORING
// ============================================

// Check device status every 30 seconds
setInterval(async () => {
    for (const [ip, device] of devices) {
        const isAlive = await ping.promise.probe(ip, { timeout: 1 });
        
        const oldStatus = device.status;
        device.status = isAlive.alive ? 'online' : 'offline';
        device.lastSeen = isAlive.alive ? new Date() : device.lastSeen;
        
        // Broadcast status change
        if (oldStatus !== device.status) {
            broadcastUpdate('status-change', {
                ip,
                status: device.status,
                lastSeen: device.lastSeen
            });
        }
    }
}, 30000);

// ============================================
// SERVER STARTUP
// ============================================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║     NETWORK MONITOR SERVER RUNNING     ║
╠════════════════════════════════════════╣
║  Web Interface: http://localhost:${PORT}  ║
║  WebSocket:     ws://localhost:3001   ║
╚════════════════════════════════════════╝

Network Information:
${JSON.stringify(getLocalNetwork(), null, 2)}

Ready to scan your network!
    `);
});

// ============================================
// PACKAGE.JSON FILE
// ============================================
// Save this as: package.json
/*
{
  "name": "network-monitor-backend",
  "version": "1.0.0",
  "description": "Network monitoring backend server",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "ping": "^0.4.4",
    "node-arp": "^1.0.6",
    "ws": "^8.14.2"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}
*/

// ============================================
// CLIENT-SIDE INTEGRATION CODE
// ============================================
// Add this to your HTML file's script section:
/*

// Connect to backend API
const API_URL = 'http://localhost:3000/api';
const WS_URL = 'ws://localhost:3001';

let ws;

// Initialize WebSocket connection
function initWebSocket() {
    ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
        console.log('Connected to server');
        showNotification('Connected', 'Connected to monitoring server');
    };
    
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleServerUpdate(message);
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        showNotification('Connection Error', 'Lost connection to server');
    };
    
    ws.onclose = () => {
        console.log('Disconnected from server');
        // Attempt to reconnect after 5 seconds
        setTimeout(initWebSocket, 5000);
    };
}

// Handle updates from server
function handleServerUpdate(message) {
    switch(message.type) {
        case 'initial':
            devices = message.data;
            updateDashboard();
            break;
        case 'scan-complete':
            devices = message.data;
            updateDashboard();
            showNotification('Scan Complete', `Found ${message.data.length} devices`);
            break;
        case 'status-change':
            const device = devices.find(d => d.ip === message.data.ip);
            if (device) {
                device.status = message.data.status;
                device.lastSeen = message.data.lastSeen;
                updateDashboard();
            }
            break;
    }
}

// Modified scanNetwork function to use backend
async function scanNetwork() {
    if (scanInProgress) return;
    
    scanInProgress = true;
    document.getElementById('scanLoader').style.display = 'inline-block';
    document.getElementById('scanText').textContent = 'Scanning...';
    
    try {
        const response = await fetch(`${API_URL}/scan`, {
            method: 'POST'
        });
        
        const result = await response.json();
        
        if (result.success) {
            devices = result.devices;
            updateDashboard();
        }
    } catch (error) {
        console.error('Scan failed:', error);
        showNotification('Scan Failed', 'Could not complete network scan');
    } finally {
        scanInProgress = false;
        document.getElementById('scanLoader').style.display = 'none';
        document.getElementById('scanText').textContent = '🔍 Scan Network';
    }
}

// Modified pingDevice function to use backend
async function pingDevice(deviceId) {
    const device = devices.find(d => d.id === deviceId);
    if (device) {
        try {
            const response = await fetch(`${API_URL}/ping/${device.ip}`, {
                method: 'POST'
            });
            
            const result = await response.json();
            
            if (result.alive) {
                showNotification('Ping Response', 
                    `${device.name} responded in ${result.responseTime}ms`);
            } else {
                showNotification('Ping Failed', 
                    `${device.name} did not respond`);
            }
        } catch (error) {
            console.error('Ping failed:', error);
        }
    }
}

// Initialize WebSocket on page load
initWebSocket();

*/
