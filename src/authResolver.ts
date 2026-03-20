import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as stream from 'stream';
import * as path from 'path';
import { promisify } from 'util';
import { SocksClient, SocksClientOptions } from 'socks';
import * as vscode from 'vscode';
import * as ssh2 from 'ssh2';
import type { ParsedKey } from 'ssh2-streams';
import Log from './common/logger';
import SSHDestination from './ssh/sshDestination';
import SSHConnection, { SSHTunnelConfig } from './ssh/sshConnection';
import SSHConfiguration from './ssh/sshConfig';
import { gatherIdentityFiles } from './ssh/identityFiles';
import { untildify, exists as fileExists } from './common/files';
import { findRandomPort } from './common/ports';
import { disposeAll } from './common/disposable';
import { installCodeServer, ServerInstallError } from './serverSetup';
import { isWindows} from './common/platform';
import * as os from 'os';

/**
 * SSH Key Management Helper Functions
 */

interface SSHKeySetupOptions {
    host: string;
    user: string;
    keyPath: string;
    logger: Log;
}

/**
 * Generates SSH key pair if it doesn't exist
 * Cross-platform compatible (Windows, macOS, Linux)
 */
async function ensureSSHKeyExists(keyPath: string, logger: Log): Promise<void> {
    if (fs.existsSync(keyPath)) {
        logger.trace(`SSH key already exists at ${keyPath}`);
        return;
    }

    logger.info(`Generating new SSH key at ${keyPath}`);
    
    const keyDir = path.dirname(keyPath);
    if (!fs.existsSync(keyDir)) {
        fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    }

    try {
        if (isWindows) {
            // Windows: Use ssh-keygen from OpenSSH
            await exec(`ssh-keygen -t rsa -b 4096 -f "${keyPath}" -N "" -q`, {
                shell: 'cmd.exe'
            });
        } else {
            // macOS/Linux: Use standard ssh-keygen with yes pipe
            await exec(`yes y | ssh-keygen -t rsa -b 4096 -f "${keyPath}" -N ""`);
        }
        
        // Set proper permissions (Unix-like systems)
        if (!isWindows) {
            fs.chmodSync(keyPath, 0o600);
            if (fs.existsSync(`${keyPath}.pub`)) {
                fs.chmodSync(`${keyPath}.pub`, 0o644);
            }
        }
        
        logger.info(`SSH key generated successfully at ${keyPath}`);
    } catch (error) {
        logger.error(`Failed to generate SSH key`, error);
        throw new Error(`Failed to generate SSH key: ${error}`);
    }
}

/**
 * Tests if SSH key works for authentication
 */
async function testSSHKeyConnection(host: string, user: string, keyPath: string, logger: Log): Promise<boolean> {
    try {
        const userHost = `${user}@${host}`;
        logger.trace(`Testing SSH key connection to ${userHost}`);
        
        const command = isWindows
            ? `ssh -i "${keyPath}" -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${userHost} "echo connected"`
            : `ssh -i ${keyPath} -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${userHost} "echo connected"`;
        
        await exec(command);
        logger.info(`SSH key authentication successful for ${userHost}`);
        return true;
    } catch (error: any) {
        logger.trace(`SSH key test failed: ${error.message}`);
        
        // Check if it's a permission denied error
        if (error.stderr && /Permission denied|publickey/.test(error.stderr)) {
            return false;
        }
        
        // Other errors might be network issues, still return false
        return false;
    }
}

/**
 * Copies SSH public key to remote host using expect script or ssh-copy-id
 */
async function installSSHKeyToRemote(host: string, user: string, keyPath: string, password: string, logger: Log): Promise<void> {
    const userHost = `${user}@${host}`;
    const pubKeyPath = `${keyPath}.pub`;
    
    if (!fs.existsSync(pubKeyPath)) {
        throw new Error(`Public key not found at ${pubKeyPath}`);
    }
    
    logger.info(`Installing SSH key to ${userHost}`);
    
    try {
        if (isWindows) {
            // Windows: Use PowerShell to copy key
            await installSSHKeyWindows(host, user, pubKeyPath, password, logger);
        } else {
            // macOS/Linux: Try ssh-copy-id first, fallback to expect
            try {
                await installSSHKeyUnix(host, user, keyPath, password, logger);
            } catch (error) {
                logger.trace(`ssh-copy-id failed, trying expect method`);
                await installSSHKeyWithExpect(host, user, pubKeyPath, password, logger);
            }
        }
        
        logger.info(`SSH key installed successfully to ${userHost}`);
    } catch (error) {
        logger.error(`Failed to install SSH key to ${userHost}`, error);
        throw new Error(`Failed to install SSH key: ${error}`);
    }
}

/**
 * Install SSH key on Windows using PowerShell
 */
async function installSSHKeyWindows(host: string, user: string, pubKeyPath: string, password: string, logger: Log): Promise<void> {
    const pubKey = fs.readFileSync(pubKeyPath, 'utf8').trim();

    
    // PowerShell script to add key to authorized_keys
    const psScript = `
$password = ConvertTo-SecureString "${password.replace(/"/g, '`"')}" -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential ("${user}", $password)
$session = New-PSSession -HostName ${host} -UserName ${user} -SSHTransport -Credential $credential
Invoke-Command -Session $session -ScriptBlock {
    $keyContent = "${pubKey.replace(/"/g, '`"')}"
    $sshDir = "$HOME/.ssh"
    $authKeysFile = "$sshDir/authorized_keys"
    
    if (!(Test-Path $sshDir)) {
        New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
    }
    
    if (!(Test-Path $authKeysFile)) {
        New-Item -ItemType File -Path $authKeysFile -Force | Out-Null
    }
    
    $existingKeys = Get-Content $authKeysFile -ErrorAction SilentlyContinue
    if ($existingKeys -notcontains $keyContent) {
        Add-Content -Path $authKeysFile -Value $keyContent
    }
}
Remove-PSSession $session
`.trim();
    
    const tempScript = path.join(os.tmpdir(), `ssh-key-install-${Date.now()}.ps1`);
    fs.writeFileSync(tempScript, psScript);
    logger.trace(`Executing PowerShell script: ${tempScript}`);
    
    try {
        await exec(`powershell -ExecutionPolicy Bypass -File "${tempScript}"`, {
            timeout: 30000
        });
    } finally {
        if (fs.existsSync(tempScript)) {
            fs.unlinkSync(tempScript);
        }
    }
}

/**
 * Install SSH key on Unix-like systems using expect script
 * This is more secure than sshpass as password is not exposed in process list
 */
async function installSSHKeyUnix(host: string, user: string, keyPath: string, password: string, logger: Log): Promise<void> {
    const userHost = `${user}@${host}`;
    const pubKeyPath = `${keyPath}.pub`;
    
    logger.info(`Installing SSH key for ${userHost} using expect script`);
    
    // Always use expect script for security (password not in process list)
    await installSSHKeyWithExpect(host, user, pubKeyPath, password, logger);
}

/**
 * Install SSH key using expect script (macOS/Linux)
 */
async function installSSHKeyWithExpect(host: string, user: string, pubKeyPath: string, password: string, logger: Log): Promise<void> {
    const userHost = `${user}@${host}`;
    const privateKeyPath = pubKeyPath.replace(/\.pub$/, '');
    
    const expectScript = `#!/usr/bin/expect -f
set timeout 30
set userHost "${userHost}"
set keyPath "${privateKeyPath}"
set password "${password.replace(/"/g, '\\"').replace(/\$/g, '\\$')}"

# Copy public key
spawn ssh-copy-id -f -i \${keyPath}.pub \$userHost
expect {
    -re "(?i)yes/no" {
        send "yes\\r"
        exp_continue
    }
    -re "(?i)password:" {
        send "\$password\\r"
        exp_continue
    }
    eof {
        # Done
    }
}

# Verify
spawn ssh -o StrictHostKeyChecking=no -i \$keyPath \$userHost "echo OK"
expect {
    -re "OK" {
        send_user "SSH key installed successfully.\\n"
    }
    eof {
        send_user "Failed to verify SSH key.\\n"
        exit 1
    }
}
`;
    
    const tempScript = path.join(os.tmpdir(), `ssh-key-install-${Date.now()}.exp`);
    fs.writeFileSync(tempScript, expectScript, { mode: 0o700 });
    
    logger.trace("Executing the expect.sh ");
    try {
        await exec(`expect ${tempScript}`, { timeout: 30000 });
    } finally {
        if (fs.existsSync(tempScript)) {
            fs.unlinkSync(tempScript);
        }
    }
}

/**
 * Updates SSH config file with host entry
 */
async function updateSSHConfig(host: string, user: string, keyPath: string, port: number = 22, logger: Log): Promise<void> {
    const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
    const sshDir = path.dirname(sshConfigPath);
    
    // Ensure .ssh directory exists
    if (!fs.existsSync(sshDir)) {
        fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    }
    
    // Create config entry
    const configEntry = `
Host ${host}
    HostName ${host}
    User ${user}
    IdentityFile ${keyPath}
    StrictHostKeyChecking no
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 10m
${port !== 22 ? `    Port ${port}` : ''}
`;
    
    // Check if entry already exists
    let existingConfig = '';
    if (fs.existsSync(sshConfigPath)) {
        existingConfig = fs.readFileSync(sshConfigPath, 'utf8');
        
        // Escape special regex characters
        const safeHost = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const safeUser = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const safeKeyPath = keyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        // Check if exact entry exists
        const blockRegex = new RegExp(
            `Host\\s+${safeHost}\\s*\\n` +
            `\\s*HostName\\s+${safeHost}\\s*\\n` +
            `\\s*User\\s+${safeUser}\\s*\\n` +
            `\\s*IdentityFile\\s+${safeKeyPath}`,
            'm'
        );
        
        if (blockRegex.test(existingConfig)) {
            logger.trace(`SSH config entry for ${host} already exists`);
            return;
        }
    }
    
    // Append new entry
    fs.appendFileSync(sshConfigPath, configEntry, { encoding: 'utf8' });
    
    // Set proper permissions (Unix-like systems)
    if (!isWindows) {
        fs.chmodSync(sshConfigPath, 0o600);
    }
    
    logger.info(`SSH config updated for ${host}`);
}

/**
 * Main function to setup SSH key authentication
 */
async function setupSSHKeyAuthentication(options: SSHKeySetupOptions): Promise<boolean> {
    const { host, user, keyPath, logger } = options;
    
    try {
        // Step 1: Ensure SSH key exists
        await ensureSSHKeyExists(keyPath, logger);
        
        // Step 2: Test if key already works
        const keyWorks = await testSSHKeyConnection(host, user, keyPath, logger);
        
        if (keyWorks) {
            logger.info(`SSH key authentication already configured for ${user}@${host}`);
            await updateSSHConfig(host, user, keyPath, 22, logger);
            return false; // No password needed
        }
        
        // Step 3: Key doesn't work, need to install it
        logger.info(`SSH key needs to be installed to ${user}@${host}`);
        
        const password = await vscode.window.showInputBox({
            prompt: `Enter password for ${user}@${host} to install SSH key`,
            password: true,
            ignoreFocusOut: true,
            placeHolder: 'Password for initial setup only'
        });
        
        if (!password) {
            throw new Error('Password required to install SSH key');
        }
        
        // Step 4: Install key to remote host
        await installSSHKeyToRemote(host, user, keyPath, password, logger);
        
        // Step 5: Verify installation
        const verifyWorks = await testSSHKeyConnection(host, user, keyPath, logger);
        if (!verifyWorks) {
            throw new Error('SSH key installation verification failed');
        }
        
        // Step 6: Update SSH config
        await updateSSHConfig(host, user, keyPath, 22, logger);
        
        vscode.window.showInformationMessage(`SSH key authentication configured for ${user}@${host}`);
        return true; // Password was used
    } catch (error) {
        logger.error(`Failed to setup SSH key authentication`, error);
        throw error;
    }
}

const exec = promisify(cp.exec);

const PASSWORD_RETRY_COUNT = 3;
const PASSPHRASE_RETRY_COUNT = 3;

export const REMOTE_SSH_AUTHORITY = 'ssh-remote';

export function getRemoteAuthority(host: string) {
    return `${REMOTE_SSH_AUTHORITY}+${host}`;
}

class TunnelInfo implements vscode.Disposable {
    constructor(
        readonly localPort: number,
        readonly remotePortOrSocketPath: number | string,
        private disposables: vscode.Disposable[]
    ) {
    }

    dispose() {
        disposeAll(this.disposables);
    }
}

interface SSHKey {
    filename: string;
    parsedKey: ParsedKey;
    fingerprint: string;
    agentSupport?: boolean;
    isPrivate?: boolean;
}

export class RemoteSSHResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {

    private proxyConnections: SSHConnection[] = [];
    private sshConnection: SSHConnection | undefined;
    private sshAgentSock: string | undefined;
    private proxyCommandProcess: cp.ChildProcessWithoutNullStreams | undefined;

    private socksTunnel: SSHTunnelConfig | undefined;
    private tunnels: TunnelInfo[] = [];

    private labelFormatterDisposable: vscode.Disposable | undefined;

    constructor(
        readonly context: vscode.ExtensionContext,
        readonly logger: Log
    ) {
    }

    resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        const [type, dest] = authority.split('+');
        if (type !== REMOTE_SSH_AUTHORITY) {
            throw new Error(`Invalid authority type for SSH resolver: ${type}`);
        }

        this.logger.info(`Resolving ssh remote authority '${authority}' (attemp #${context.resolveAttempt})`);

        const sshDest = SSHDestination.parseEncoded(dest);

        // It looks like default values are not loaded yet when resolving a remote,
        // so let's hardcode the default values here
        const remoteSSHconfig = vscode.workspace.getConfiguration('remote.SSH');
        const enableDynamicForwarding = remoteSSHconfig.get<boolean>('enableDynamicForwarding', true)!;
        const enableAgentForwarding = remoteSSHconfig.get<boolean>('enableAgentForwarding', true)!;
        const serverDownloadUrlTemplate = remoteSSHconfig.get<string>('serverDownloadUrlTemplate');
        const defaultExtensions = remoteSSHconfig.get<string[]>('defaultExtensions', []);
        const remotePlatformMap = remoteSSHconfig.get<Record<string, string>>('remotePlatform', {});
        const remoteServerListenOnSocket = remoteSSHconfig.get<boolean>('remoteServerListenOnSocket', false)!;
        const connectTimeout = remoteSSHconfig.get<number>('connectTimeout', 60)!;
        const enableAutoSSHKeySetup = remoteSSHconfig.get<boolean>('enableAutoSSHKeySetup', false)!;

        return vscode.window.withProgress({
            title: `Setting up SSH Host ${sshDest.hostname}`,
            location: vscode.ProgressLocation.Notification,
            cancellable: false
        }, async () => {
            try {
                const sshconfig = await SSHConfiguration.loadFromFS();
                const sshHostConfig = sshconfig.getHostConfiguration(sshDest.hostname);
                const sshHostName = sshHostConfig['HostName'] ? sshHostConfig['HostName'].replace('%h', sshDest.hostname) : sshDest.hostname;
                const sshUser = sshHostConfig['User'] || sshDest.user || os.userInfo().username || ''; // https://github.com/openssh/openssh-portable/blob/5ec5504f1d328d5bfa64280cd617c3efec4f78f3/sshconnect.c#L1561-L1562
                const sshPort = sshHostConfig['Port'] ? parseInt(sshHostConfig['Port'], 10) : (sshDest.port || 22);

                // Auto SSH Key Setup (if enabled)
                if (enableAutoSSHKeySetup && context.resolveAttempt === 1) {
                    try {
                        const defaultKeyPath = path.join(os.homedir(), '.ssh', `id_rsa_${sshDest.hostname}`);
                        await setupSSHKeyAuthentication({
                            host: sshHostName,
                            user: sshUser,
                            keyPath: defaultKeyPath,
                            logger: this.logger
                        });
                    } catch (error) {
                        this.logger.trace(`Auto SSH key setup failed, continuing with normal authentication: ${error}`);
                        // Continue with normal authentication flow
                    }
                }

                this.sshAgentSock = sshHostConfig['IdentityAgent'] || process.env['SSH_AUTH_SOCK'] || (isWindows ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
                this.sshAgentSock = this.sshAgentSock ? untildify(this.sshAgentSock) : undefined;
                const agentForward = enableAgentForwarding && (sshHostConfig['ForwardAgent'] || 'no').toLowerCase() === 'yes';
                const agent = agentForward && this.sshAgentSock ? new ssh2.OpenSSHAgent(this.sshAgentSock) : undefined;

                const preferredAuthentications = sshHostConfig['PreferredAuthentications'] ? sshHostConfig['PreferredAuthentications'].split(',').map(s => s.trim()) : ['publickey', 'password', 'keyboard-interactive'];

                const identityFiles: string[] = (sshHostConfig['IdentityFile'] as unknown as string[]) || [];
                const identitiesOnly = (sshHostConfig['IdentitiesOnly'] || 'no').toLowerCase() === 'yes';
                const identityKeys = await gatherIdentityFiles(identityFiles, this.sshAgentSock, identitiesOnly, this.logger);

                // Create proxy jump connections if any
                let proxyStream: ssh2.ClientChannel | stream.Duplex | undefined;
                if (sshHostConfig['ProxyJump']) {
                    const proxyJumps = sshHostConfig['ProxyJump'].split(',').filter(i => !!i.trim())
                        .map(i => {
                            const proxy = SSHDestination.parse(i);
                            const proxyHostConfig = sshconfig.getHostConfiguration(proxy.hostname);
                            return [proxy, proxyHostConfig] as [SSHDestination, Record<string, string>];
                        });
                    for (let i = 0; i < proxyJumps.length; i++) {
                        const [proxy, proxyHostConfig] = proxyJumps[i];
                        const proxyHostName = proxyHostConfig['HostName'] || proxy.hostname;
                        const proxyUser = proxyHostConfig['User'] || proxy.user || sshUser;
                        const proxyPort = proxyHostConfig['Port'] ? parseInt(proxyHostConfig['Port'], 10) : (proxy.port || sshPort);

                        const proxyAgentForward = enableAgentForwarding && (proxyHostConfig['ForwardAgent'] || 'no').toLowerCase() === 'yes';
                        const proxyAgent = proxyAgentForward && this.sshAgentSock ? new ssh2.OpenSSHAgent(this.sshAgentSock) : undefined;

                        const proxyIdentityFiles: string[] = (proxyHostConfig['IdentityFile'] as unknown as string[]) || [];
                        const proxyIdentitiesOnly = (proxyHostConfig['IdentitiesOnly'] || 'no').toLowerCase() === 'yes';
                        const proxyIdentityKeys = await gatherIdentityFiles(proxyIdentityFiles, this.sshAgentSock, proxyIdentitiesOnly, this.logger);

                        const proxyAuthHandler = this.getSSHAuthHandler(proxyUser, proxyHostName, proxyIdentityKeys, preferredAuthentications);
                        const proxyConnection = new SSHConnection({
                            host: !proxyStream ? proxyHostName : undefined,
                            port: !proxyStream ? proxyPort : undefined,
                            sock: proxyStream,
                            username: proxyUser,
                            readyTimeout: connectTimeout * 1000,
                            strictVendor: false,
                            agentForward: proxyAgentForward,
                            agent: proxyAgent,
                            authHandler: (arg0, arg1, arg2) => (proxyAuthHandler(arg0, arg1, arg2), undefined)
                        });
                        this.proxyConnections.push(proxyConnection);

                        const nextProxyJump = i < proxyJumps.length - 1 ? proxyJumps[i + 1] : undefined;
                        const destIP = nextProxyJump ? (nextProxyJump[1]['HostName'] || nextProxyJump[0].hostname) : sshHostName;
                        const destPort = nextProxyJump ? ((nextProxyJump[1]['Port'] && parseInt(nextProxyJump[1]['Port'], 10)) || nextProxyJump[0].port || 22) : sshPort;
                        proxyStream = await proxyConnection.forwardOut('127.0.0.1', 0, destIP, destPort);
                    }
                } else if (sshHostConfig['ProxyCommand']) {
                    let proxyArgs = (sshHostConfig['ProxyCommand'] as unknown as string[])
                        .map((arg) => arg.replace('%h', sshHostName).replace('%n', sshDest.hostname).replace('%p', sshPort.toString()).replace('%r', sshUser));
                    let proxyCommand = proxyArgs.shift()!;

                    let options = {};
                    if (isWindows && /\.(bat|cmd)$/.test(proxyCommand)) {
                        proxyCommand = `"${proxyCommand}"`;
                        proxyArgs = proxyArgs.map((arg) => arg.includes(' ') ? `"${arg}"` : arg);
                        options = { shell: true, windowsHide: true, windowsVerbatimArguments: true };
                    }

                    this.logger.trace(`Spawning ProxyCommand: ${proxyCommand} ${proxyArgs.join(' ')}`);

                    const child = cp.spawn(proxyCommand, proxyArgs, options);
                    proxyStream = stream.Duplex.from({ readable: child.stdout, writable: child.stdin });
                    this.proxyCommandProcess = child;
                }

                // Create final shh connection
                const sshAuthHandler = this.getSSHAuthHandler(sshUser, sshHostName, identityKeys, preferredAuthentications);

                this.sshConnection = new SSHConnection({
                    host: !proxyStream ? sshHostName : undefined,
                    port: !proxyStream ? sshPort : undefined,
                    sock: proxyStream,
                    username: sshUser,
                    readyTimeout: connectTimeout * 1000,
                    strictVendor: false,
                    agentForward,
                    agent,
                    authHandler: (arg0, arg1, arg2) => (sshAuthHandler(arg0, arg1, arg2), undefined),
                });
                await this.sshConnection.connect();

                const envVariables: Record<string, string | null> = {};
                if (agentForward) {
                    envVariables['SSH_AUTH_SOCK'] = null;
                }

                const installResult = await installCodeServer(this.sshConnection, serverDownloadUrlTemplate, defaultExtensions, Object.keys(envVariables), remotePlatformMap[sshDest.hostname], remoteServerListenOnSocket, this.logger);

                for (const key of Object.keys(envVariables)) {
                    if (installResult[key] !== undefined) {
                        envVariables[key] = installResult[key];
                    }
                }

                // Update terminal env variables
                this.context.environmentVariableCollection.persistent = false;
                for (const [key, value] of Object.entries(envVariables)) {
                    if (value) {
                        this.context.environmentVariableCollection.replace(key, value);
                    }
                }

                if (enableDynamicForwarding) {
                    const socksPort = await findRandomPort();
                    this.socksTunnel = await this.sshConnection!.addTunnel({
                        name: `ssh_tunnel_socks_${socksPort}`,
                        localPort: socksPort,
                        socks: true
                    });
                }

                const tunnelConfig = await this.openTunnel(0, installResult.listeningOn);
                this.tunnels.push(tunnelConfig);

                // Enable ports view
                vscode.commands.executeCommand('setContext', 'forwardedPortsViewEnabled', true);

                this.labelFormatterDisposable?.dispose();
                this.labelFormatterDisposable = vscode.workspace.registerResourceLabelFormatter({
                    scheme: 'vscode-remote',
                    authority: `${REMOTE_SSH_AUTHORITY}+*`,
                    formatting: {
                        label: '${path}',
                        separator: '/',
                        tildify: true,
                        workspaceSuffix: `SSH: ${sshDest.hostname}` + (sshDest.port && sshDest.port !== 22 ? `:${sshDest.port}` : '')
                    }
                });

                const resolvedResult: vscode.ResolverResult = new vscode.ResolvedAuthority('127.0.0.1', tunnelConfig.localPort, installResult.connectionToken);
                resolvedResult.extensionHostEnv = envVariables;
                return resolvedResult;
            } catch (e: unknown) {
                this.logger.error(`Error resolving authority`, e);

                // Initial connection
                if (context.resolveAttempt === 1) {
                    this.logger.show();

                    const closeRemote = 'Close Remote';
                    const retry = 'Retry';
                    const result = await vscode.window.showErrorMessage(`Could not establish connection to "${sshDest.hostname}"`, { modal: true }, closeRemote, retry);
                    if (result === closeRemote) {
                        await vscode.commands.executeCommand('workbench.action.remote.close');
                    } else if (result === retry) {
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                }

                if (e instanceof ServerInstallError || !(e instanceof Error)) {
                    throw vscode.RemoteAuthorityResolverError.NotAvailable(e instanceof Error ? e.message : String(e));
                } else {
                    throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(e.message);
                }
            }
        });
    }

    private async openTunnel(localPort: number, remotePortOrSocketPath: number | string) {
        localPort = localPort > 0 ? localPort : await findRandomPort();

        const disposables: vscode.Disposable[] = [];
        const remotePort = typeof remotePortOrSocketPath === 'number' ? remotePortOrSocketPath : undefined;
        const remoteSocketPath = typeof remotePortOrSocketPath === 'string' ? remotePortOrSocketPath : undefined;
        if (this.socksTunnel && remotePort) {
            const forwardingServer = await new Promise<net.Server>((resolve, reject) => {
                this.logger.trace(`Creating forwarding server ${localPort}(local) => ${this.socksTunnel!.localPort!}(socks) => ${remotePort}(remote)`);
                const socksOptions: SocksClientOptions = {
                    proxy: {
                        host: '127.0.0.1',
                        port: this.socksTunnel!.localPort!,
                        type: 5
                    },
                    command: 'connect',
                    destination: {
                        host: '127.0.0.1',
                        port: remotePort
                    }
                };
                const server: net.Server = net.createServer()
                    .on('error', reject)
                    .on('connection', async (socket: net.Socket) => {
                        try {
                            const socksConn = await SocksClient.createConnection(socksOptions);
                            socket.pipe(socksConn.socket);
                            socksConn.socket.pipe(socket);
                        } catch (error) {
                            this.logger.error(`Error while creating SOCKS connection`, error);
                        }
                    })
                    .on('listening', () => resolve(server))
                    .listen(localPort);
            });
            disposables.push({
                dispose: () => forwardingServer.close(() => {
                    this.logger.trace(`SOCKS forwading server closed`);
                }),
            });
        } else {
            this.logger.trace(`Opening tunnel ${localPort}(local) => ${remotePortOrSocketPath}(remote)`);
            const tunnelConfig = await this.sshConnection!.addTunnel({
                name: `ssh_tunnel_${localPort}_${remotePortOrSocketPath}`,
                remoteAddr: '127.0.0.1',
                remotePort,
                remoteSocketPath,
                localPort
            });
            disposables.push({
                dispose: () => {
                    this.sshConnection?.closeTunnel(tunnelConfig.name);
                    this.logger.trace(`Tunnel ${tunnelConfig.name} closed`);
                }
            });
        }

        return new TunnelInfo(localPort, remotePortOrSocketPath, disposables);
    }

    private getSSHAuthHandler(sshUser: string, sshHostName: string, identityKeys: SSHKey[], preferredAuthentications: string[]) {
        let passwordRetryCount = PASSWORD_RETRY_COUNT;
        let keyboardRetryCount = PASSWORD_RETRY_COUNT;
        identityKeys = identityKeys.slice();
        return async (methodsLeft: string[] | null, _partialSuccess: boolean | null, callback: (nextAuth: ssh2.AuthHandlerResult) => void) => {
            if (methodsLeft === null) {
                this.logger.info(`Trying no-auth authentication`);

                return callback({
                    type: 'none',
                    username: sshUser,
                });
            }
            if (methodsLeft.includes('publickey') && identityKeys.length && preferredAuthentications.includes('publickey')) {
                const identityKey = identityKeys.shift()!;

                this.logger.info(`Trying publickey authentication: ${identityKey.filename} ${identityKey.parsedKey.type} SHA256:${identityKey.fingerprint}`);

                if (identityKey.agentSupport) {
                    return callback({
                        type: 'agent',
                        username: sshUser,
                        agent: new class extends ssh2.OpenSSHAgent {
                            // Only return the current key
                            override getIdentities(callback: (err: Error | undefined, publicKeys?: ParsedKey[]) => void): void {
                                callback(undefined, [identityKey.parsedKey]);
                            }
                        }(this.sshAgentSock!)
                    });
                }
                if (identityKey.isPrivate) {
                    return callback({
                        type: 'publickey',
                        username: sshUser,
                        key: identityKey.parsedKey
                    });
                }
                if (!await fileExists(identityKey.filename)) {
                    // Try next identity file
                    return callback(null as any);
                }

                const keyBuffer = await fs.promises.readFile(identityKey.filename);
                let result = ssh2.utils.parseKey(keyBuffer); // First try without passphrase
                if (result instanceof Error && result.message === 'Encrypted private OpenSSH key detected, but no passphrase given') {
                    let passphraseRetryCount = PASSPHRASE_RETRY_COUNT;
                    while (result instanceof Error && passphraseRetryCount > 0) {
                        const passphrase = await vscode.window.showInputBox({
                            title: `Enter passphrase for ${identityKey.filename}`,
                            password: true,
                            ignoreFocusOut: true
                        });
                        if (!passphrase) {
                            break;
                        }
                        result = ssh2.utils.parseKey(keyBuffer, passphrase);
                        passphraseRetryCount--;
                    }
                }
                if (!result || result instanceof Error) {
                    // Try next identity file
                    return callback(null as any);
                }

                const key = Array.isArray(result) ? result[0] : result;
                return callback({
                    type: 'publickey',
                    username: sshUser,
                    key
                });
            }
            if (methodsLeft.includes('password') && passwordRetryCount > 0 && preferredAuthentications.includes('password')) {
                if (passwordRetryCount === PASSWORD_RETRY_COUNT) {
                    this.logger.info(`Trying password authentication`);
                }

                const password = await vscode.window.showInputBox({
                    title: `Enter password for ${sshUser}@${sshHostName}`,
                    password: true,
                    ignoreFocusOut: true
                });
                passwordRetryCount--;

                return callback(password
                    ? {
                        type: 'password',
                        username: sshUser,
                        password
                    }
                    : false);
            }
            if (methodsLeft.includes('keyboard-interactive') && keyboardRetryCount > 0 && preferredAuthentications.includes('keyboard-interactive')) {
                if (keyboardRetryCount === PASSWORD_RETRY_COUNT) {
                    this.logger.info(`Trying keyboard-interactive authentication`);
                }

                return callback({
                    type: 'keyboard-interactive',
                    username: sshUser,
                    prompt: async (_name, _instructions, _instructionsLang, prompts, finish) => {
                        const responses: string[] = [];
                        for (const prompt of prompts) {
                            const response = await vscode.window.showInputBox({
                                title: `(${sshUser}@${sshHostName}) ${prompt.prompt}`,
                                password: !prompt.echo,
                                ignoreFocusOut: true
                            });
                            if (response === undefined) {
                                keyboardRetryCount = 0;
                                break;
                            }
                            responses.push(response);
                        }
                        keyboardRetryCount--;
                        finish(responses);
                    }
                });
            }

            callback(false);
        };
    }

    dispose() {
        disposeAll(this.tunnels);
        // If there's proxy connections then just close the parent connection
        if (this.proxyConnections.length) {
            this.proxyConnections[0].close();
        } else {
            this.sshConnection?.close();
        }
        this.proxyCommandProcess?.kill();
        this.labelFormatterDisposable?.dispose();
    }
}
