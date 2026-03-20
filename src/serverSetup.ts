import * as crypto from 'crypto';
import * as vscode from 'vscode';
import Log from './common/logger';
import { getVSCodeServerConfig } from './serverConfig';
import SSHConnection from './ssh/sshConnection';
import * as https from 'https';

export interface ServerInstallOptions {
    id: string;
    quality: string;
    commit: string;
    version: string;
    release?: string; // vscodium specific
    extensionIds: string[];
    envVariables: string[];
    useSocketPath: boolean;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverDownloadUrlTemplate: string;
}

export interface ServerSystem{
    os: string;
    arch: string;
    platform: string;
    host: string;
    user: string;
    release?: string; // vscodium specific
}

export interface ServerInstallResult {
    exitCode: number;
    listeningOn: number | string;
    connectionToken: string;
    logFile: string;
    osReleaseId: string;
    arch: string;
    platform: string;
    tmpDir: string;
    [key: string]: any;
}

export class ServerInstallError extends Error {
    constructor(message: string) {
        super(message);
    }
}

const DEFAULT_DOWNLOAD_URL_TEMPLATE = 'https://github.com/VSCodium/vscodium/releases/download/${version}.${release}/vscodium-reh-${os}-${arch}-${version}.${release}.tar.gz';

// Default GitHub repository for installation scripts
const DEFAULT_SCRIPTS_BASE_URL = 'https://raw.githubusercontent.com/KV2773/vscodium-server-script/main';

/**
 * Get the configured script base URL or use default
 */
function getScriptBaseUrl(): string {
    const config = vscode.workspace.getConfiguration('remote.SSH');
    const customUrl = config.get<string>('serverInstallScriptUrl', '').trim();
    return customUrl || DEFAULT_SCRIPTS_BASE_URL;
}

/**
 * Fetch installation script from configured URL with timeout and error handling
 */
async function fetchScriptFromGitHub(scriptName: string, logger: Log): Promise<string | null> {
    const baseUrl = getScriptBaseUrl();
    const scriptUrl = `${baseUrl}/${scriptName}`;
    
    logger.trace(`Fetching installation script from: ${scriptUrl}`);
    
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            logger.trace(`Timeout fetching script from GitHub: ${scriptUrl}`);
            resolve(null);
        }, 5000); // 5 second timeout
        
        https.get(scriptUrl, (response) => {
            clearTimeout(timeout);
            
            if (response.statusCode !== 200) {
                logger.trace(`Failed to fetch script from GitHub: HTTP ${response.statusCode}`);
                resolve(null);
                return;
            }
            
            let data = '';
            response.setEncoding('utf8');
            
            response.on('data', (chunk) => {
                data += chunk;
            });
            
            response.on('end', () => {
                logger.trace(`Successfully fetched script from GitHub: ${scriptName}`);
                resolve(data);
            });
        }).on('error', (error) => {
            clearTimeout(timeout);
            logger.trace(`Error fetching script from GitHub: ${error.message}`);
            resolve(null);
        });
    });
}

/**
 * Get script name based on platform
 */
function getScriptNameForPlatform(platform: string): string {
    // Map platform to script filename
    const scriptMap: Record<string, string> = {
        'aix': 'AIX',
        'linux': 'Linux',
        'darwin': 'macOS',
        'freebsd': 'FreeBSD',
        'dragonfly': 'DragonFly',
    };
    
    return scriptMap[platform.toLowerCase()] || 'Linux';
}

export async function installCodeServer(conn: SSHConnection, serverDownloadUrlTemplate: string | undefined, extensionIds: string[], envVariables: string[], platform: string | undefined, useSocketPath: boolean, logger: Log): Promise<ServerInstallResult> {
    let shell = 'powershell';

    // detect platform and shell for windows
    if (!platform || platform === 'windows') {
        const result = await conn.exec('uname -s');

        if (result.stdout) {
            if (result.stdout.includes('windows32')) {
                platform = 'windows';
            } else if (result.stdout.includes('MINGW64')) {
                platform = 'windows';
                shell = 'bash';
            }
        } else if (result.stderr) {
            if (result.stderr.includes('FullyQualifiedErrorId : CommandNotFoundException')) {
                platform = 'windows';
            }

            if (result.stderr.includes('is not recognized as an internal or external command')) {
                platform = 'windows';
                shell = 'cmd';
            }
        }

        if (platform) {
            logger.trace(`Detected platform: ${platform}, ${shell}`);
        }
    }

    const scriptId = crypto.randomBytes(12).toString('hex');

    const vscodeServerConfig = await getVSCodeServerConfig();
    const installOptions: ServerInstallOptions = {
        id: scriptId,
        version: vscodeServerConfig.version,
        commit: vscodeServerConfig.commit,
        quality: vscodeServerConfig.quality,
        release: vscodeServerConfig.release,
        extensionIds,
        envVariables,
        useSocketPath,
        serverApplicationName: vscodeServerConfig.serverApplicationName,
        serverDataFolderName: vscodeServerConfig.serverDataFolderName,
        serverDownloadUrlTemplate: serverDownloadUrlTemplate || vscodeServerConfig.serverDownloadUrlTemplate || DEFAULT_DOWNLOAD_URL_TEMPLATE,
    };

    let commandOutput: { stdout: string; stderr: string };
    if (platform === 'windows') {
        const installServerScript = generatePowerShellInstallScript(installOptions);

        logger.trace('Server install command:', installServerScript);

        const installDir = `$HOME\\${vscodeServerConfig.serverDataFolderName}\\install`;
        const installScript = `${installDir}\\${vscodeServerConfig.commit}.ps1`;
        const endRegex = new RegExp(`${scriptId}: end`);
        // investigate if it's possible to use `-EncodedCommand` flag
        // https://devblogs.microsoft.com/powershell/invoking-powershell-with-complex-expressions-using-scriptblocks/
        let command = '';
        if (shell === 'powershell') {
            command = `md -Force ${installDir}; echo @'\n${installServerScript}\n'@ | Set-Content ${installScript}; powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'bash') {
            command = `mkdir -p ${installDir.replace(/\\/g, '/')} && echo '\n${installServerScript.replace(/'/g, '\'"\'"\'')}\n' > ${installScript.replace(/\\/g, '/')} && powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'cmd') {
            const script = installServerScript.trim()
                // remove comments
                .replace(/^#.*$/gm, '')
                // remove empty lines
                .replace(/\n{2,}/gm, '\n')
                // remove leading spaces
                .replace(/^\s*/gm, '')
                // escape double quotes (from powershell/cmd)
                .replace(/"/g, '"""')
                // escape single quotes (from cmd)
                .replace(/'/g, `''`)
                // escape redirect (from cmd)
                .replace(/>/g, `^>`)
                // escape new lines (from powershell/cmd)
                .replace(/\n/g, '\'`n\'');

            command = `powershell "md -Force ${installDir}" && powershell "echo '${script}'" > ${installScript.replace('$HOME', '%USERPROFILE%')} && powershell -ExecutionPolicy ByPass -File "${installScript.replace('$HOME', '%USERPROFILE%')}"`;

            logger.trace('Command length (8191 max):', command.length);

            if (command.length > 8191) {
                throw new ServerInstallError(`Command line too long`);
            }
        } else {
            throw new ServerInstallError(`Not supported shell: ${shell}`);
        }

        commandOutput = await conn.execPartial(command, (stdout: string) => endRegex.test(stdout));
    } else {

        let systemInfo = null;
        try {
        // Execute commands and get stdout
        const { stdout: os } = await conn.exec(`uname -s`);
        const { stdout: arch } = await conn.exec(`uname -m`);
        const { stdout: platform } = await conn.exec(`uname -o`);
        let { stdout: host } = await conn.exec(`hostname | nslookup `);
        const {stdout: user}  = await conn.exec(`whoami`);
        
        host = host.trim().split('\n')[3].split(':')[1].trim();

        // Store trimmed values
         systemInfo = {
            os: os.trim(),
            arch: arch.trim(),
            platform: platform.trim(),
            host: host.trim(),
            user: user.trim()
        };
        
        console.log('System Info:', systemInfo);
        } catch (error) {
            console.error('Failed to get system info:', error);
            throw error;
        }



        const installServerScript = await generateBashInstallScript(installOptions, systemInfo?.platform || 'linux', systemInfo, logger);

        logger.trace('Server install command:', installServerScript);
        // Fish shell does not support heredoc so let's workaround it using -c option,
        // also replace single quotes (') within the script with ('\'') as there's no quoting within single quotes, see https://unix.stackexchange.com/a/24676
        commandOutput = await conn.exec(`bash -c '${installServerScript.replace(/'/g, `'\\''`)}'`);
    }

    if (commandOutput.stderr) {
        logger.trace('Server install command stderr:', commandOutput.stderr);
    }
    logger.trace('Server install command stdout:', commandOutput.stdout);

    const resultMap = parseServerInstallOutput(commandOutput.stdout, scriptId);
    if (!resultMap) {
        throw new ServerInstallError(`Failed parsing install script output`);
    }

    const exitCode = parseInt(resultMap.exitCode, 10);
    if (exitCode !== 0) {
        throw new ServerInstallError(`Couldn't install vscode server on remote server, install script returned non-zero exit status`);
    }

    const listeningOn = resultMap.listeningOn.match(/^\d+$/)
        ? parseInt(resultMap.listeningOn, 10)
        : resultMap.listeningOn;

    const remoteEnvVars = Object.fromEntries(Object.entries(resultMap).filter(([key,]) => envVariables.includes(key)));

    return {
        exitCode,
        listeningOn,
        connectionToken: resultMap.connectionToken,
        logFile: resultMap.logFile,
        osReleaseId: resultMap.osReleaseId,
        arch: resultMap.arch,
        platform: resultMap.platform,
        tmpDir: resultMap.tmpDir,
        ...remoteEnvVars
    };
}

function parseServerInstallOutput(str: string, scriptId: string): { [k: string]: string } | undefined {
    const startResultStr = `${scriptId}: start`;
    const endResultStr = `${scriptId}: end`;

    const startResultIdx = str.indexOf(startResultStr);
    if (startResultIdx < 0) {
        return undefined;
    }

    const endResultIdx = str.indexOf(endResultStr, startResultIdx + startResultStr.length);
    if (endResultIdx < 0) {
        return undefined;
    }

    const installResult = str.substring(startResultIdx + startResultStr.length, endResultIdx);

    const resultMap: { [k: string]: string } = {};
    const resultArr = installResult.split(/\r?\n/);
    for (const line of resultArr) {
        const [key, value] = line.split('==');
        resultMap[key] = value;
    }

    return resultMap;
}

async function generateBashInstallScript(
    { id, quality, version, commit, release, extensionIds, envVariables, useSocketPath,
      serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate }: ServerInstallOptions,
    platform: string,
    systemInfo: ServerSystem | null,
    logger: Log
): Promise<string> {
    const extensions = extensionIds.map(id => '--install-extension ' + id).join(' ');
    
    // Determine which script to fetch based on platform
    const scriptName = getScriptNameForPlatform(platform);
    logger.trace(`Attempting to fetch installation script for platform: ${platform} (${scriptName})`);
    
    // Try to fetch script from GitHub
    let scriptTemplate = await fetchScriptFromGitHub(scriptName, logger);
    
    // If fetch failed, use embedded fallback script
    if (!scriptTemplate) {
        logger.info(`Using embedded fallback script for platform: ${platform}`);
        scriptTemplate = getEmbeddedBashScript();
    } else {
        logger.info(`Using script from GitHub for platform: ${platform}`);
    }
    
    // Replace placeholders in the script with actual values
    const socketPath = useSocketPath
        ? `--socket-path="\\$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"`
        : '--port=0';
    
    let script = scriptTemplate
        .replace(/\$\{SCRIPT_ID\}/g, id)
        .replace(/\$\{DISTRO_VERSION\}/g, version)
        .replace(/\$\{DISTRO_COMMIT\}/g, commit)
        .replace(/\$\{DISTRO_QUALITY\}/g, quality)
        .replace(/\$\{DISTRO_VSCODIUM_RELEASE\}/g, release ?? '')
        .replace(/\$\{SERVER_APP_NAME\}/g, serverApplicationName)
        .replace(/\$\{SERVER_EXTENSIONS\}/g, extensions)
        .replace(/\$\{SERVER_DATA_FOLDER\}/g, serverDataFolderName)
        .replace(/\$\{SERVER_DOWNLOAD_URL_TEMPLATE\}/g, serverDownloadUrlTemplate)
        .replace(/\$\{USE_SOCKET_PATH\}/g, socketPath)
        .replace(/\$\{ENV_VARIABLES\}/g, envVariables.join(','))
        .replace(/\$\{crypto\.randomUUID\(\)\}/g, crypto.randomUUID());
    
    // Add system info variables if available
    if (systemInfo) {
        script = script
            .replace(/\$\{SYSTEM_OS\}/g, systemInfo.os)
            .replace(/\$\{SYSTEM_ARCH\}/g, systemInfo.arch)
            .replace(/\$\{SYSTEM_PLATFORM\}/g, systemInfo.platform)
            .replace(/\$\{SYSTEM_HOST\}/g, systemInfo.host)
            .replace(/\$\{SYSTEM_USER\}/g, systemInfo.user);
    }
    
    return script;
}

/**
 * Get embedded fallback bash installation script
 * This is used when GitHub fetch fails
 */
function getEmbeddedBashScript(): string {
    // Return the original embedded script as fallback
    // Using placeholder syntax that will be replaced by .replace() calls
    return `
# Server installation script

# Ensure HOME is set first
if [ -z "\\$HOME" ]; then
    export HOME="\\$(eval echo ~\\$(whoami))"
fi

echo "\${DISTRO_VERSION}"
echo "\${DISTRO_COMMIT}"

TMP_DIR="\${XDG_RUNTIME_DIR:-\\"/tmp\\"}"
DISTRO_VERSION="\${DISTRO_VERSION}"
DISTRO_BUILD_VERSION="1.105.17075"
DISTRO_COMMIT="\${DISTRO_COMMIT}"
DISTRO_QUALITY="\${DISTRO_QUALITY}"
DISTRO_VSCODIUM_RELEASE="\${DISTRO_VSCODIUM_RELEASE}"

SERVER_APP_NAME="\${SERVER_APP_NAME}"
SERVER_INITIAL_EXTENSIONS="\${SERVER_EXTENSIONS}"
SERVER_LISTEN_FLAG="\${USE_SOCKET_PATH}"
SERVER_DATA_DIR="\\$HOME/\${SERVER_DATA_FOLDER}"
SERVER_DIR="\\$SERVER_DATA_DIR/bin/\\$DISTRO_COMMIT"
SERVER_SCRIPT="\\$SERVER_DIR/bin/\\$SERVER_APP_NAME"
SERVER_LOGFILE="\\$SERVER_DATA_DIR/.\\$DISTRO_COMMIT.log"
SERVER_PIDFILE="\\$SERVER_DATA_DIR/.\\$DISTRO_COMMIT.pid"
SERVER_TOKENFILE="\\$SERVER_DATA_DIR/.\\$DISTRO_COMMIT.token"
SERVER_ARCH=
SERVER_CONNECTION_TOKEN=
SERVER_DOWNLOAD_URL=

LISTENING_ON=
OS_RELEASE_ID=
ARCH=
PLATFORM=

# System Info (available if detected)
SYSTEM_OS="\${SYSTEM_OS}"
SYSTEM_ARCH="\${SYSTEM_ARCH}"
SYSTEM_PLATFORM="\${SYSTEM_PLATFORM}"
SYSTEM_HOST="\${SYSTEM_HOST}"
SYSTEM_USER="\${SYSTEM_USER}"

# Mimic output from logs of remote-ssh extension
print_install_results_and_exit() {
    echo "\${SCRIPT_ID}: start"
    echo "exitCode==\\$1=="
    echo "listeningOn==\\$LISTENING_ON=="
    echo "connectionToken==\\$SERVER_CONNECTION_TOKEN=="
    echo "logFile==\\$SERVER_LOGFILE=="
    echo "osReleaseId==\\$OS_RELEASE_ID=="
    echo "arch==\\$ARCH=="
    echo "platform==\\$PLATFORM=="
    echo "tmpDir==\\$TMP_DIR=="
    echo "\${SCRIPT_ID}: end"
    exit 0
}

# Check if platform is supported
KERNEL="\\$(uname -s)"
case \\$KERNEL in
    Darwin)
        PLATFORM="darwin"
        ;;
    Linux)
        PLATFORM="linux"
        ;;
    FreeBSD)
        PLATFORM="freebsd"
        ;;
    DragonFly)
        PLATFORM="dragonfly"
        ;;
    AIX)
        PLATFORM="aix"
        ;;
    *)
        echo "Error platform not supported: \\$KERNEL"
        print_install_results_and_exit 1
        ;;
esac

# Check machine architecture
ARCH="\\$(uname -m)"
case \\$ARCH in
    x86_64 | amd64)
        SERVER_ARCH="x64"
        ;;
    armv7l | armv8l)
        SERVER_ARCH="armhf"
        ;;
    arm64 | aarch64)
        SERVER_ARCH="arm64"
        ;;
    ppc64le)
        SERVER_ARCH="ppc64le"
        ;;
    ppc64|powerpc64)
        SERVER_ARCH="ppc64"
        ;;
    riscv64)
        SERVER_ARCH="riscv64"
        ;;
    loongarch64)
        SERVER_ARCH="loong64"
        ;;
    s390x)
        SERVER_ARCH="s390x"
        ;;
    *)
        # Handle AIX special case where uname -m returns machine ID
        if [[ \\$PLATFORM == "aix" ]]; then
            AIX_ARCH="\\$(uname -p 2>/dev/null)"
            case \\$AIX_ARCH in
                powerpc)
                    SERVER_ARCH="ppc64"
                    ARCH="ppc64"
                    ;;
                *)
                    echo "Error AIX architecture not supported: \\$AIX_ARCH"
                    print_install_results_and_exit 1
                    ;;
            esac
        else
            echo "Error architecture not supported: \\$ARCH"
            print_install_results_and_exit 1
        fi
        ;;
esac

# Add freeware path for AIX
if [[ \\$PLATFORM == "aix" ]]; then
    export PATH="/opt/freeware/bin:\\$PATH"
fi

# Handle OS release detection
if [[ \\$PLATFORM == "aix" ]]; then
    OS_RELEASE_ID="aix"
else
    OS_RELEASE_ID="\\$(grep -i '^ID=' /etc/os-release 2>/dev/null | sed 's/^[Ii][Dd]=//' | sed 's/\\"//g')"
    if [[ -z \\$OS_RELEASE_ID ]]; then
        OS_RELEASE_ID="\\$(grep -i '^ID=' /usr/lib/os-release 2>/dev/null | sed 's/^[Ii][Dd]=//' | sed 's/\\"//g')"
        if [[ -z \\$OS_RELEASE_ID ]]; then
            OS_RELEASE_ID="unknown"
        fi
    fi
fi

# Create installation folder
if [[ ! -d \\$SERVER_DIR ]]; then
    mkdir -p \\$SERVER_DIR
    if (( \\$? > 0 )); then
        echo "Error creating server install directory"
        print_install_results_and_exit 1
    fi
fi

# adjust platform for vscodium download, if needed
if [[ \\$OS_RELEASE_ID = alpine ]]; then
    PLATFORM=\\$OS_RELEASE_ID
fi

# Build server download URL
if [[ \\$PLATFORM == "aix" ]]; then
    # For AIX, use the VSCodium build version (e.g. 1.105.17075), not the upstream VS Code version (1.105.1)
    SERVER_DOWNLOAD_URL="https://github.com/KV2773/vscodium/releases/download/1.105.1%2Bbob1.0.0/vscodium-server.tar.gz"

    echo "Downloading VSCodium server for AIX from GitHub..."
    echo "URL: \\$SERVER_DOWNLOAD_URL"
else
    # Original VSCodium/VSCODE URL for other platforms
    SERVER_DOWNLOAD_URL="\\$(echo "\${SERVER_DOWNLOAD_URL_TEMPLATE}" \\
        | sed "s/\\\\\${quality}/\\$DISTRO_QUALITY/g" \\
        | sed "s/\\\\\${version}/\\$DISTRO_VERSION/g" \\
        | sed "s/\\\\\${commit}/\\$DISTRO_COMMIT/g" \\
        | sed "s/\\\\\${os}/\\$PLATFORM/g" \\
        | sed "s/\\\\\${arch}/\\$SERVER_ARCH/g" \\
        | sed "s/\\\\\${release}/\\$DISTRO_VSCODIUM_RELEASE/g")"
fi

# Check if server script is already installed
if [[ ! -f \\$SERVER_SCRIPT ]]; then
    case "\\$PLATFORM" in
        darwin | linux | alpine | aix )
            ;;
        *)
            echo "Error '\\$PLATFORM' needs manual installation of remote extension host"
            print_install_results_and_exit 1
            ;;
    esac

    pushd \\$SERVER_DIR > /dev/null || {
        echo "Error: Failed to enter server directory \\$SERVER_DIR"
        print_install_results_and_exit 1
    }

    # Standard download logic for all platforms including AIX
    if [[ ! -z \\$(which wget) ]]; then
        wget --tries=3 --timeout=10 --continue --no-verbose -O vscode-server.tar.gz \\$SERVER_DOWNLOAD_URL
    elif [[ ! -z \\$(which curl) ]]; then
        curl --retry 3 --connect-timeout 10 --location --show-error --silent --output vscode-server.tar.gz \\$SERVER_DOWNLOAD_URL
    else
        echo "Error no tool to download server binary"
        print_install_results_and_exit 1
    fi

    if (( \\$? > 0 )); then
        echo "Error downloading server from \\$SERVER_DOWNLOAD_URL"
        print_install_results_and_exit 1
    fi

    echo "Extracting server package..."
    if ! tar -xzf vscode-server.tar.gz --strip-components 1; then
        echo "Error while extracting server contents"
        print_install_results_and_exit 1
    fi

    if (( \\$? > 0 )); then
        echo "Error while extracting server contents"
        print_install_results_and_exit 1
    fi

    # Special handling for AIX server wrapper
    if [[ \\$PLATFORM == "aix" ]]; then
        # Detect Node.js from multiple possible locations
        NODE_PATH=""
        
        # First, check if node is in PATH
        if command -v node >/dev/null 2>&1; then
            NODE_PATH="\\$(command -v node)"
            echo "Found Node.js in PATH: \\$NODE_PATH"
        fi
        
        # If not in PATH, check common system locations
        if [[ -z "\\$NODE_PATH" ]]; then
            for node_location in "/opt/nodejs/bin/node" "/usr/bin/node" "/usr/local/bin/node"; do
                if [[ -x "\\$node_location" ]]; then
                    NODE_PATH="\\$node_location"
                    echo "Found system Node.js at \\$NODE_PATH"
                    break
                fi
            done
        fi
        
        # If still not found, check for downloaded Node.js in home directory
        if [[ -z "\\$NODE_PATH" ]]; then
            EXISTING_NODE=\\$(find "\\$HOME" -maxdepth 1 -type d -name "node-v*-aix-ppc64" 2>/dev/null | head -1)
            
            if [[ -n "\\$EXISTING_NODE" ]] && [[ -x "\\$EXISTING_NODE/bin/node" ]]; then
                echo "Found existing Node.js at \\$EXISTING_NODE"
                export PATH="\\$EXISTING_NODE/bin:\\$PATH"
                NODE_PATH="\\$EXISTING_NODE/bin/node"
            else
                # Download new Node.js as last resort
                cd "\\$HOME/"
                echo "Node.js not found, downloading and installing..."
                wget --tries=3 --timeout=10 --continue --no-verbose -O node-v24.14.0-aix-ppc64.tar.gz https://nodejs.org/dist/v24.14.0/node-v24.14.0-aix-ppc64.tar.gz
                tar -xzf node-v24.14.0-aix-ppc64.tar.gz -C "\\$HOME/"
                rm -f node-v24.14.0-aix-ppc64.tar.gz
                export PATH="\\$HOME/node-v24.14.0-aix-ppc64/bin:\\$PATH"
                NODE_PATH="\\$HOME/node-v24.14.0-aix-ppc64/bin/node"
            fi
        fi
        
        # Verify Node.js is now available
        if [[ -n "\\$NODE_PATH" ]] && [[ -x "\\$NODE_PATH" ]]; then
            echo "Using Node.js: \\$NODE_PATH"
            "\\$NODE_PATH" --version
        else
            echo "ERROR: Could not find or install Node.js"
            print_install_results_and_exit 1
        fi

        # Ensure the AIX server wrapper is executable
        if [[ -f "\\$SERVER_DIR/bin/codium-server" ]]; then
            chmod +x "\\$SERVER_DIR/bin/codium-server"
            echo "AIX server wrapper made executable"

            # Create symlink if VS Code expects code-server but we have codium-server
            if [[ "\\$SERVER_APP_NAME" == "bobide-server" && ! -f "\\$SERVER_DIR/bin/bobide-server" ]]; then
                ln -sf "\\$SERVER_DIR/bin/codium-server" "\\$SERVER_DIR/bin/bobide-server"
                echo "Created symlink: bobide-server -> codium-server"
            fi
        fi
        # Get Node.js directory
        NODE_DIR="\\$(dirname "\\$NODE_PATH")"
        NODE_PRE_DIR="\\$(dirname "\\$NODE_DIR")"

        echo "=== Patching Server Files ==="
        echo "DEBUG: NODE_PATH=\\$NODE_PATH"
        echo "DEBUG: NODE_DIR=\\$NODE_DIR"
        echo "DEBUG: NODE_PRE_DIR=\\$NODE_PRE_DIR"
        echo "Replacing: /opt/nodejs"
        echo "With: \\$NODE_PRE_DIR"

        # Count files to patch
        FILE_COUNT=\\$(find "\\$SERVER_DIR" -type f \\( -name "*.sh" -o -name "*.js" -o -name "*.json" -o -name "*-server" \\) -exec grep -l "/opt/nodejs" {} \\; 2>/dev/null | wc -l)
        echo "Found \\$FILE_COUNT files to patch"

        if [[ \\$FILE_COUNT -gt 0 ]]; then
            find "\\$SERVER_DIR" -type f \\( -name "*.sh" -o -name "*.js" -o -name "*.json" -o -name "*-server"\\) -exec grep -l "/opt/nodejs" {} \\; 2>/dev/null | while read -r file; do
                echo "  Patching: \\\${file#\\$SERVER_DIR/}"
                sed -i.bak "s|/opt/nodejs|\\\${NODE_PRE_DIR}|g" "\\$file"
                rm -f "\\\${file}.bak"
            done
            echo "✓ Patched \\$FILE_COUNT files"
        else
            echo "No files need patching"
        fi

        # Patch product.json to match Bob IDE commit/version for client handshake
        if [[ -f "\\$SERVER_DIR/product.json" ]]; then
            echo "=== AIX VSCodium Server Version Update ==="
            echo "Patching product.json with Bob IDE values..."
            echo "Target Version: \\$DISTRO_VERSION"
            echo "Target Commit: \\$DISTRO_COMMIT"
            
            # Backup original product.json
            cp "\\$SERVER_DIR/product.json" "\\$SERVER_DIR/product.json.backup"
            
            # Update version and commit in product.json using perl for in-place editing
            # This ensures the AIX server (VSCodium build) reports the correct Bob IDE version
            perl -i -pe "s/\\"version\\":\\s*\\"[^\\"]*\\"/\\"version\\": \\"\\$DISTRO_VERSION\\"/" "\\$SERVER_DIR/product.json"
            perl -i -pe "s/\\"commit\\":\\s*\\"[^\\"]*\\"/\\"commit\\": \\"\\$DISTRO_COMMIT\\"/" "\\$SERVER_DIR/product.json"
            
            echo "✓ product.json patched successfully"
            echo "Verification:"
            grep -E '(commit|version)' "\\$SERVER_DIR/product.json" | head -5
            echo "Backup saved: product.json.backup"
        else
            echo "Warning: product.json not found at \\$SERVER_DIR/product.json"
        fi
        
        # Update package.json if it exists
        if [[ -f "\\$SERVER_DIR/package.json" ]]; then
            echo "Updating package.json version..."
            cp "\\$SERVER_DIR/package.json" "\\$SERVER_DIR/package.json.backup"
            perl -i -pe "s/\\"version\\":\\s*\\"[^\\"]*\\"/\\"version\\": \\"\\$DISTRO_VERSION\\"/" "\\$SERVER_DIR/package.json"
            echo "✓ package.json updated"
        fi
        
        # Create version marker files for reference
        echo "\\$DISTRO_VERSION" > "\\$SERVER_DIR/version"
        echo "\\$DISTRO_COMMIT" > "\\$SERVER_DIR/commit"
        echo "✓ Created version marker files"
        
        
        echo "=== AIX Server Setup Complete ==="

BASHRC="\\$HOME/.bashrc"
SNIPPET_MARKER="# === VSCodium remote-cli PATH setup ==="

# Create .bashrc if it doesn't exist
if [ ! -f "\\$BASHRC" ]; then
  touch "\\$BASHRC"
fi

# Add snippet only if it's not already present
if ! grep -Fq "\\$SNIPPET_MARKER" "\\$BASHRC"; then
  cat >> "\\$BASHRC" <<'EOF'

# === VSCodium remote-cli PATH setup ===
# Add all matching remote-cli directories to PATH
if [ -d "\\$HOME/.vscodium-server/bin" ]; then
  for dir in "\\$HOME"/.vscodium-server/bin/*/bin/remote-cli; do
      if [ -d "\\$dir" ]; then
          PATH="\\$PATH:\\$dir"
      fi
  done
  export PATH
fi
# === End VSCodium remote-cli PATH setup ===

EOF
  echo "remote-cli PATH snippet added to \\$BASHRC"
else
  echo "Snippet already present in \\$BASHRC, not adding again."
fi
    fi

    if [[ ! -f \\$SERVER_SCRIPT ]]; then
        echo "Error server contents are corrupted"
        echo "Expected script at: \\$SERVER_SCRIPT"
        echo "Directory contents:"
        ls -la "\\$SERVER_DIR/bin/" || true
        print_install_results_and_exit 1
    fi
    
    echo "Server script found: \\$SERVER_SCRIPT"
    echo "Server script is executable: \\$(test -x \\$SERVER_SCRIPT && echo yes || echo no)"

    rm -f vscode-server.tar.gz

    popd > /dev/null
else
    echo "Server script already installed in \\$SERVER_SCRIPT"
fi

# Try to find if server is already running
if [[ -f \\$SERVER_PIDFILE ]]; then
    SERVER_PID="\\$(cat \\$SERVER_PIDFILE)"
    SERVER_RUNNING_PROCESS="\\$(ps -o pid,args -p \\$SERVER_PID | grep \\$SERVER_SCRIPT)"
else
    SERVER_RUNNING_PROCESS="\\$(ps -o pid,args -A | grep \\$SERVER_SCRIPT | grep -v grep)"
fi

if [[ -z \\$SERVER_RUNNING_PROCESS ]]; then
    if [[ -f \\$SERVER_LOGFILE ]]; then
        rm \\$SERVER_LOGFILE
    fi
    if [[ -f \\$SERVER_TOKENFILE ]]; then
        rm \\$SERVER_TOKENFILE
    fi

    touch \\$SERVER_TOKENFILE
    chmod 600 \\$SERVER_TOKENFILE
    SERVER_CONNECTION_TOKEN="\${crypto.randomUUID()}"
    echo \\$SERVER_CONNECTION_TOKEN > \\$SERVER_TOKENFILE

    \\$SERVER_SCRIPT --start-server --host=127.0.0.1 \\$SERVER_LISTEN_FLAG \\$SERVER_INITIAL_EXTENSIONS --connection-token-file \\$SERVER_TOKENFILE --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms &> \\$SERVER_LOGFILE &
    echo \\$! > \\$SERVER_PIDFILE
else
    echo "Server script is already running \\$SERVER_SCRIPT"
fi

if [[ -f \\$SERVER_TOKENFILE ]]; then
    SERVER_CONNECTION_TOKEN="\\$(cat \\$SERVER_TOKENFILE)"
else
    echo "Error server token file not found \\$SERVER_TOKENFILE"
    print_install_results_and_exit 1
fi

if [[ -f \\$SERVER_LOGFILE ]]; then
    for i in {1..5}; do
        LISTENING_ON="\\$(cat \\$SERVER_LOGFILE | grep -E 'Extension host agent listening on .+' | sed 's/Extension host agent listening on //')"
        if [[ -n \\$LISTENING_ON ]]; then
            break
        fi
        sleep 0.5
    done

    if [[ -z \\$LISTENING_ON ]]; then
        echo "Error server did not start successfully"
        print_install_results_and_exit 1
    fi
else
    echo "Error server log file not found \\$SERVER_LOGFILE"
    print_install_results_and_exit 1
fi

# Finish server setup
print_install_results_and_exit 0
`;
}

function generatePowerShellInstallScript({ id, quality, version, commit, release, extensionIds, envVariables, useSocketPath, serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate }: ServerInstallOptions) {
    const extensions = extensionIds.map(id => '--install-extension ' + id).join(' ');
    const downloadUrl = serverDownloadUrlTemplate
        .replace(/\$\{quality\}/g, quality)
        .replace(/\$\{version\}/g, version)
        .replace(/\$\{commit\}/g, commit)
        .replace(/\$\{os\}/g, 'win32')
        .replace(/\$\{arch\}/g, 'x64')
        .replace(/\$\{release\}/g, release ?? '');

    return `
# Server installation script

$TMP_DIR="$env:TEMP\\$([System.IO.Path]::GetRandomFileName())"
$ProgressPreference = "SilentlyContinue"

$DISTRO_VERSION="${version}"
$DISTRO_COMMIT="${commit}"
$DISTRO_QUALITY="${quality}"
$DISTRO_VSCODIUM_RELEASE="${release ?? ''}"

$SERVER_APP_NAME="${serverApplicationName}"
$SERVER_INITIAL_EXTENSIONS="${extensions}"
$SERVER_LISTEN_FLAG="${useSocketPath ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"` : '--port=0'}"
$SERVER_DATA_DIR="$(Resolve-Path ~)\\${serverDataFolderName}"
$SERVER_DIR="$SERVER_DATA_DIR\\bin\\$DISTRO_COMMIT"
$SERVER_SCRIPT="$SERVER_DIR\\bin\\$SERVER_APP_NAME.cmd"
$SERVER_LOGFILE="$SERVER_DATA_DIR\\.$DISTRO_COMMIT.log"
$SERVER_PIDFILE="$SERVER_DATA_DIR\\.$DISTRO_COMMIT.pid"
$SERVER_TOKENFILE="$SERVER_DATA_DIR\\.$DISTRO_COMMIT.token"
$SERVER_ARCH=
$SERVER_CONNECTION_TOKEN=
$SERVER_DOWNLOAD_URL=

$LISTENING_ON=
$OS_RELEASE_ID=
$ARCH=
$PLATFORM="win32"

function printInstallResults($code) {
    "${id}: start"
    "exitCode==$code=="
    "listeningOn==$LISTENING_ON=="
    "connectionToken==$SERVER_CONNECTION_TOKEN=="
    "logFile==$SERVER_LOGFILE=="
    "osReleaseId==$OS_RELEASE_ID=="
    "arch==$ARCH=="
    "platform==$PLATFORM=="
    "tmpDir==$TMP_DIR=="
    ${envVariables.map(envVar => `"${envVar}==$${envVar}=="`).join('\n')}
    "${id}: end"
}

# Check machine architecture
$ARCH=$env:PROCESSOR_ARCHITECTURE
# Use x64 version for ARM64, as it's not yet available.
if(($ARCH -eq "AMD64") -or ($ARCH -eq "IA64") -or ($ARCH -eq "ARM64")) {
    $SERVER_ARCH="x64"
}
else {
    "Error architecture not supported: $ARCH"
    printInstallResults 1
    exit 0
}

# Create installation folder
if(!(Test-Path $SERVER_DIR)) {
    try {
        ni -it d $SERVER_DIR -f -ea si
    } catch {
        "Error creating server install directory - $($_.ToString())"
        exit 1
    }

    if(!(Test-Path $SERVER_DIR)) {
        "Error creating server install directory"
        exit 1
    }
}

cd $SERVER_DIR

# Check if server script is already installed
if(!(Test-Path $SERVER_SCRIPT)) {
    del vscode-server.tar.gz

    $REQUEST_ARGUMENTS = @{
        Uri="${downloadUrl}"
        TimeoutSec=20
        OutFile="vscode-server.tar.gz"
        UseBasicParsing=$True
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    Invoke-RestMethod @REQUEST_ARGUMENTS

    if(Test-Path "vscode-server.tar.gz") {
        tar -xf vscode-server.tar.gz --strip-components 1

        del vscode-server.tar.gz
    }

    if(!(Test-Path $SERVER_SCRIPT)) {
        "Error while installing the server binary"
        exit 1
    }
}
else {
    "Server script already installed in $SERVER_SCRIPT"
}

# Try to find if server is already running
if(Get-Process node -ErrorAction SilentlyContinue | Where-Object Path -Like "$SERVER_DIR\\*") {
    echo "Server script is already running $SERVER_SCRIPT"
}
else {
    if(Test-Path $SERVER_LOGFILE) {
        del $SERVER_LOGFILE
    }
    if(Test-Path $SERVER_PIDFILE) {
        del $SERVER_PIDFILE
    }
    if(Test-Path $SERVER_TOKENFILE) {
        del $SERVER_TOKENFILE
    }

    $SERVER_CONNECTION_TOKEN="${crypto.randomUUID()}"
    [System.IO.File]::WriteAllLines($SERVER_TOKENFILE, $SERVER_CONNECTION_TOKEN)

    $SCRIPT_ARGUMENTS="--start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file $SERVER_TOKENFILE --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms *> '$SERVER_LOGFILE'"

    $START_ARGUMENTS = @{
        FilePath = "powershell.exe"
        WindowStyle = "hidden"
        ArgumentList = @(
            "-ExecutionPolicy", "Unrestricted", "-NoLogo", "-NoProfile", "-NonInteractive", "-c", "$SERVER_SCRIPT $SCRIPT_ARGUMENTS"
        )
        PassThru = $True
    }

    $SERVER_ID = (start @START_ARGUMENTS).ID

    if($SERVER_ID) {
        [System.IO.File]::WriteAllLines($SERVER_PIDFILE, $SERVER_ID)
    }
}

if(Test-Path $SERVER_TOKENFILE) {
    $SERVER_CONNECTION_TOKEN="$(cat $SERVER_TOKENFILE)"
}
else {
    "Error server token file not found $SERVER_TOKENFILE"
    printInstallResults 1
    exit 0
}

sleep -Milliseconds 500

$SELECT_ARGUMENTS = @{
    Path = $SERVER_LOGFILE
    Pattern = "Extension host agent listening on (\\d+)"
}

for($I = 1; $I -le 5; $I++) {
    if(Test-Path $SERVER_LOGFILE) {
        $GROUPS = (Select-String @SELECT_ARGUMENTS).Matches.Groups

        if($GROUPS) {
            $LISTENING_ON = $GROUPS[1].Value
            break
        }
    }

    sleep -Milliseconds 500
}

if(!(Test-Path $SERVER_LOGFILE)) {
    "Error server log file not found $SERVER_LOGFILE"
    printInstallResults 1
    exit 0
}

# Finish server setup
printInstallResults 0

if($SERVER_ID) {
    while($True) {
        if(!(gps -Id $SERVER_ID)) {
            "server died, exit"
            exit 0
        }

        sleep 30
    }
}
`;
}
