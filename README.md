# Open Remote - SSH

![Open Remote SSH](https://raw.githubusercontent.com/jeanp413/open-remote-ssh/master/docs/images/open-remote-ssh.gif)

## SSH Host Requirements
You can connect to a running SSH server on the following platforms.

**Supported**:

- x86_64 Debian 8+, Ubuntu 16.04+, CentOS / RHEL 7+ Linux.
- ARMv7l (AArch32) Raspbian Stretch/9+ (32-bit).
- ARMv8l (AArch64) Ubuntu 18.04+ (64-bit).
- macOS 10.14+ (Mojave)
- Windows 10+
- FreeBSD 13 (Requires manual remote-extension-host installation)
- DragonFlyBSD (Requires manual remote-extension-host installation)

## Requirements

**Activation**

> NOTE: Not needed in VSCodium since version 1.75

Enable the extension in your `argv.json`


```json
{
    ...
    "enable-proposed-api": [
        ...,
        "jeanp413.open-remote-ssh",
    ]
    ...
}
```
which you can open by running the `Preferences: Configure Runtime Arguments` command.
The file is located in `~/.vscode-oss/argv.json`.

**Alpine linux**

When running on alpine linux, the packages `libstdc++` and `bash` are necessary and can be installed via
running
```bash
sudo apk add bash libstdc++
```

## Features

### 🔑 Automatic SSH Key Setup (New!)

Tired of entering passwords every time you connect? Enable automatic SSH key setup to configure password-less authentication on first connection.

**Enable in settings:**
```json
{
  "remote.SSH.enableAutoSSHKeySetup": true
}
```

The extension will:
- Generate SSH keys automatically
- Install them to your remote host (password required once)
- Configure SSH for persistent connections
- Future connections require no password!

**Supported on:** Windows, macOS, and Linux

📖 [Full Documentation](docs/SSH_KEY_SETUP.md)

### 🔧 Custom Installation Scripts

Host your own server installation scripts instead of relying on the default repository. This is useful for:
- Using custom or modified installation scripts
- Working in air-gapped or restricted environments
- Maintaining your own fork of installation scripts

**How to Configure:**

**Option 1: Using VS Code Settings UI**
1. Open VS Code Settings (`Ctrl+,` or `Cmd+,` on Mac)
2. Search for `remote.SSH.serverInstallScriptUrl`
3. Enter your custom script URL

**Option 2: Using settings.json**
1. Open Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P` on Mac)
2. Type `Preferences: Open User Settings (JSON)`
3. Add the following configuration:

```json
{
  "remote.SSH.serverInstallScriptUrl": "https://raw.githubusercontent.com/yourusername/yourrepo/main"
}
```

**Script Requirements:**
- Your repository must contain platform-specific scripts named: `Linux`, `macOS`, `AIX`, `FreeBSD`, `DragonFly`
- Scripts must be accessible via HTTP/HTTPS
- The extension will append the platform name to your base URL

**Example:**
If you set `https://example.com/scripts`, the extension will fetch:
- `https://example.com/scripts/Linux` for Linux systems
- `https://example.com/scripts/macOS` for macOS systems
- etc.

**Default:** `https://raw.githubusercontent.com/KV2773/vscodium-server-script/main`

### SSH Configuration File

[OpenSSH](https://www.openssh.com/) supports using a [configuration file](https://linuxize.com/post/using-the-ssh-config-file/) to store all your different SSH connections. To use an SSH config file, run the `Remote-SSH: Open SSH Configuration File...` command.
