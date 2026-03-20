# Automatic SSH Key Setup

This feature automatically configures SSH key-based authentication for your remote connections, eliminating the need to enter passwords repeatedly.

## Overview

When enabled, the extension will:
1. Generate an SSH key pair if it doesn't exist
2. Test if the key already works for authentication
3. If not, prompt for your password once to install the public key
4. Update your SSH config for persistent connection settings

## Configuration

Enable this feature in your VS Code settings:

```json
{
  "remote.SSH.enableAutoSSHKeySetup": false  // Set to true to enable
}
```

Or via UI: `Settings` → `Remote - SSH` → `Enable Auto SSH Key Setup`

## How It Works

### First Connection (Key Setup)

1. **Key Generation**: If no SSH key exists for the host, a new RSA 4096-bit key pair is generated at `~/.ssh/id_rsa_<hostname>`

2. **Key Testing**: The extension tests if the key already works (in case it was set up previously)

3. **Key Installation**: If the key doesn't work, you'll be prompted for your password **once** to install the public key to the remote host's `~/.ssh/authorized_keys`

4. **SSH Config Update**: The extension updates your `~/.ssh/config` with:
   ```
   Host <hostname>
       HostName <hostname>
       User <username>
       IdentityFile ~/.ssh/id_rsa_<hostname>
       StrictHostKeyChecking no
       ControlMaster auto
       ControlPath ~/.ssh/cm-%r@%h:%p
       ControlPersist 10m
   ```

### Subsequent Connections

After the initial setup, all future connections to that host will use the SSH key automatically - **no password required**.

## Platform Support

### ✅ Linux
- Uses `ssh-keygen` for key generation
- Uses `ssh-copy-id` or `expect` for key installation
- Full support for all features

### ✅ macOS
- Uses `ssh-keygen` for key generation
- Uses `ssh-copy-id` or `expect` for key installation
- Full support for all features

### ✅ Windows
- Uses OpenSSH's `ssh-keygen` (included in Windows 10+)
- Uses PowerShell remoting for key installation
- Requires OpenSSH client to be installed

## Requirements

### All Platforms
- SSH client installed and in PATH
- Network access to the remote host

### Linux/macOS
- `ssh-keygen` (usually pre-installed)
- `ssh-copy-id` or `expect` (for key installation)

### Windows
- OpenSSH Client (Windows 10 1809+ includes it by default)
- PowerShell 5.1 or later

To install OpenSSH on Windows:
```powershell
# Run as Administrator
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
```

## Security Considerations

### Key Storage
- Private keys are stored in `~/.ssh/` with permissions `600` (owner read/write only)
- Public keys are stored with permissions `644` (owner read/write, others read)
- Keys are named per-host: `id_rsa_<hostname>` to avoid conflicts

### Password Handling
- Your password is only used once during initial setup
- Password is never stored or logged
- Password is transmitted securely via SSH protocol

### SSH Config
- ControlMaster enables connection multiplexing (reuses existing connections)
- ControlPersist keeps the connection alive for 10 minutes after last use
- StrictHostKeyChecking is disabled for convenience (can be changed manually)

## Troubleshooting

### Key Generation Fails

**Error**: `Failed to generate SSH key`

**Solutions**:
- Ensure `ssh-keygen` is in your PATH
- Check that `~/.ssh/` directory exists and is writable
- On Windows, verify OpenSSH Client is installed

### Key Installation Fails

**Error**: `Failed to install SSH key`

**Solutions**:
- Verify the password is correct
- Ensure the remote host allows password authentication (temporarily)
- Check that the remote host's `~/.ssh/` directory is writable
- On Linux/macOS, install `expect` if `ssh-copy-id` is not available:
  ```bash
  # Ubuntu/Debian
  sudo apt-get install expect
  
  # macOS
  brew install expect
  ```

### Connection Still Asks for Password

**Possible causes**:
1. Key wasn't installed successfully - check the extension logs
2. Remote host's `~/.ssh/authorized_keys` has wrong permissions:
   ```bash
   chmod 700 ~/.ssh
   chmod 600 ~/.ssh/authorized_keys
   ```
3. Remote host's SSH server doesn't allow public key authentication - check `/etc/ssh/sshd_config`:
   ```
   PubkeyAuthentication yes
   ```

### View Logs

To see detailed logs:
1. Open Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
2. Run: `Remote-SSH: Show Log`
3. Look for messages about SSH key setup

## Manual Setup Alternative

If automatic setup doesn't work, you can set up SSH keys manually:

### Linux/macOS
```bash
# Generate key
ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa_myhost

# Copy to remote
ssh-copy-id -i ~/.ssh/id_rsa_myhost user@hostname

# Add to SSH config
cat >> ~/.ssh/config << EOF
Host myhost
    HostName hostname
    User user
    IdentityFile ~/.ssh/id_rsa_myhost
EOF
```

### Windows (PowerShell)
```powershell
# Generate key
ssh-keygen -t rsa -b 4096 -f $env:USERPROFILE\.ssh\id_rsa_myhost

# Copy to remote (enter password when prompted)
type $env:USERPROFILE\.ssh\id_rsa_myhost.pub | ssh user@hostname "cat >> .ssh/authorized_keys"

# Add to SSH config
Add-Content $env:USERPROFILE\.ssh\config @"
Host myhost
    HostName hostname
    User user
    IdentityFile ~/.ssh/id_rsa_myhost
"@
```

## Disabling the Feature

To disable automatic SSH key setup:

1. Open Settings
2. Search for "Remote SSH Auto Key"
3. Uncheck "Enable Auto SSH Key Setup"

Or in `settings.json`:
```json
{
  "remote.SSH.enableAutoSSHKeySetup": false
}
```

Existing SSH keys and configurations will remain unchanged.

## FAQ

**Q: Will this work with my existing SSH keys?**  
A: Yes! The extension checks if your existing keys work before generating new ones.

**Q: Can I use this with jump hosts/bastion servers?**  
A: The feature works with direct connections. For ProxyJump configurations, set up keys manually.

**Q: Does this work with SSH agents?**  
A: Yes, the extension respects existing SSH agent configurations.

**Q: What if I have multiple users on the same host?**  
A: Each user gets their own key: `id_rsa_<hostname>` is stored in your local `~/.ssh/` directory.

**Q: Can I customize the key path?**  
A: Currently, keys are automatically named `id_rsa_<hostname>`. Manual customization requires editing `~/.ssh/config`.

**Q: Is this secure?**  
A: Yes! SSH key authentication is more secure than password authentication. Keys are stored with proper permissions and never transmitted over the network.

## Related Settings

- `remote.SSH.configFile` - Custom SSH config file location
- `remote.SSH.connectTimeout` - Connection timeout in seconds
- `remote.SSH.enableAgentForwarding` - Enable SSH agent forwarding
- `remote.SSH.remotePlatform` - Specify remote platform (linux/macos/windows)

## Support

For issues or questions:
- Check the [troubleshooting section](#troubleshooting)
- View extension logs: `Remote-SSH: Show Log`
- Report issues: [GitHub Issues](https://github.com/jeanp413/open-remote-ssh/issues)