# MSBuild Remote Runner (VS Code extension)

Adds **Build** and **Run** buttons to the VS Code status bar that build and
run a .NET Framework / ASP.NET project over SSH on a remote Windows machine
(e.g. a Windows VM in Parallels Desktop), from VS Code on macOS.

## What it does

- **Build**: SSHes into the configured Windows host and runs `msbuild.exe`
  against your solution. Output streams into an "MSBuild Remote" output
  channel.
- **Run**: SSHes in and, before starting anything, idempotently opens the
  Windows Firewall and fixes IIS Express's hostname binding for each site's
  port (see [Remote setup for Run](#remote-setup-for-run)), then launches
  `iisexpress.exe` against your site folder and port, in a dedicated VS Code
  terminal. You'll be prompted with a link to open the running site in your
  browser.
- **Stop**: force-kills `iisexpress.exe` on the remote host (useful if the
  terminal was closed without stopping it cleanly).

Configuration lives in a JSON file at the **root of your project**, so
different projects/workspaces can point at different hosts, paths, and
ports.

## Install (from source)

```bash
cd msbuild-remote-runner
npm install
npm run compile
```

Then either:

- Press `F5` in VS Code with this folder open to launch an Extension
  Development Host with it loaded, or
- Package it into a `.vsix` and install that:
  ```bash
  npm install -g @vscode/vsce
  vsce package --allow-missing-repository
  code --install-extension msbuild-remote-runner-0.3.0.vsix
  ```
  The `--allow-missing-repository` flag silences `vsce`'s warning about the
  missing `repository` field in `package.json` — expected here since this is
  a local, unpublished extension with no git remote.

  Note: packaging currently bundles your project's own
  `.msbuildremote.json` (with your real host/paths) into the `.vsix`. That's
  harmless for local install-for-yourself use, but exclude it via
  `.vscodeignore` before sharing the package with anyone else.

## First run

Open your ASP.NET project folder in VS Code. The extension automatically
creates a `.msbuildremote.json` file in the project root the first time you
click **Build** or **Run**, pre-filled with placeholder values. Edit it to
match your setup (see `.msbuildremote.example.json` in this repo for
reference), then click Build/Run again.

You can also open it directly via the Command Palette:
`MSBuild Remote: Open Config File`

### Config fields

| Field           | Required | Description |
|-----------------|----------|-------------|
| `host`          | yes | IP or hostname of the Windows VM, e.g. `10.211.55.3` |
| `user`          | yes | SSH username on the Windows machine |
| `identityFile`  | no  | Path to your SSH private key. Omit to use password/agent auth |
| `msbuildPath`   | yes | Full path to `MSBuild.exe` on the Windows machine |
| `solutionPath`  | yes | Path to the `.sln` file, **as seen from Windows** — a UNC path like `\\Mac\Home\...` avoids per-session drive-mapping issues |
| `configuration` | yes | Build configuration, e.g. `Release` or `Debug` |
| `target`        | yes | MSBuild target, e.g. `Rebuild` or `Build` |
| `iisExpressPath`| no* | Full path to `iisexpress.exe`. Required for Run (single-site mode) |
| `sitePath`      | no* | Path to the site's physical folder, as seen from Windows. Required for Run (single-site mode) |
| `port`          | no* | Port for IIS Express to bind. Required for Run (single-site mode) |
| `slnLaunchFile` | no  | Path, relative to the workspace root, to a `.slnLaunch` / `.slnLaunch.user` file. Only needed to override auto-detection — see below |
| `slnLaunchProfile` | no | Name of the profile to use from that file. Defaults to the first profile |
| `sites`         | no  | Optional per-project overrides — sitePath/port/iisExpressPath are otherwise auto-derived, see below |
| `autoConfigureRemote` | no | Set to `false` to skip the automatic firewall/binding setup described below (defaults to `true`) |
| `driveMappings` | no | Map drive letter(s) via `net use` before each Build/Run SSH command - see [Drive mappings](#drive-mappings-for-postbuild-events-that-reject-unc-paths) below |
| `skipBuildEvents` | no | Set to `false` to let each project's PreBuildEvent/PostBuildEvent run as normal (defaults to `true`, which blanks them out via `/p:PreBuildEvent=`/`/p:PostBuildEvent=` - see below) |

\* Required only if you use the Run button, and only when there's no `.slnLaunch`/`.slnLaunch.user` file (auto-detected or via `slnLaunchFile`) driving multi-site mode.

## Multi-project (.slnLaunch) support

Visual Studio's "multiple startup projects" feature (2022 17.9+) saves which
projects should launch together into a `.slnLaunch` (shared) or
`.slnLaunch.user` (local) JSON file next to the `.sln`. This extension
drives Run/Stop from that same file — you don't have to duplicate the
project list, tell it where the file is, or tell it each project's port.

**Both the `.slnLaunch` file and each project's port are auto-detected —
`slnLaunchFile` and `sites` are optional overrides, not requirements:**

- The workspace is scanned (skipping `node_modules`, `bin`, `obj`, `.git`,
  etc., a few levels deep) for a `*.slnLaunch` / `*.slnLaunch.user` file. A
  `.user` file is preferred when both exist, since that's the one Visual
  Studio itself launches from. As soon as one is found, Run/Stop switch into
  multi-site mode automatically — no config needed. Set `slnLaunchFile`
  yourself only if you need to point at a specific file (e.g. more than one
  solution in the workspace).
- For each enabled project in the chosen profile, its port is read straight
  from the `<IISUrl>` that Visual Studio's Web project properties write —
  checking `<ProjectName>.csproj.user` first (where that setting lands if
  "Save server settings in user file" was checked), then the `.csproj`
  itself. Its `sitePath` is derived from `solutionPath` plus the project's
  own relative path, so it doesn't need to be typed out either.

Since both files live inside the project folder that's already shared with
the VM, the extension reads and parses them directly from macOS — no SSH
round trip needed just to figure out which projects and ports are in play.

This is enough for most projects with no extra config at all. Use `sites`
only to override specific projects — e.g. a custom `iisExpressPath` per
project, or a project whose `.csproj` doesn't carry a usable `<IISUrl>`:

```json
"sites": [
  {
    "projectPath": "YourWeb\\YourWeb.csproj",
    "name": "Web",
    "sitePath": "\\\\Mac\\Home\\path\\to\\YourWeb",
    "port": 8080
  }
]
```

A project matched here skips auto-detection entirely and uses this entry
instead.

Notes:

- `projectPath` should match (or be a suffix of) the `Path` field for that
  project inside the `.slnLaunch` file — see `.msbuildremote.example.json`
  for a full example. Slashes and case are normalized before comparing, so
  small formatting differences are fine.
- `slnLaunchProfile` is optional; if omitted, the first profile in the file
  is used.
- Only projects whose `Action` is `Start` or `StartWithoutDebugging` are
  launched — anything set to `None` in Visual Studio's dialog is skipped.
- A project listed in the profile that has neither a matching `sites` entry
  nor a resolvable `<IISUrl>` is skipped with a note in the output channel,
  rather than failing the whole run — useful if your profile includes
  non-web projects (console apps, Azure Functions, etc.) this extension
  doesn't know how to launch. You can still start those manually; this just
  won't do it for you.
- Each matched project gets its own terminal (named after `name` — or the
  project's file name when auto-detected — or its project path) so their
  IIS Express logs don't interleave.
- **Stop** kills only the processes bound to the ports you configured
  (via a remote `Get-NetTCPConnection` + `Stop-Process` call), not every
  `iisexpress.exe` on the box — so it won't take down unrelated sites on
  the same VM. If no ports are known yet, it falls back to
  `taskkill /IM iisexpress.exe /F`.
- If `slnLaunchFile` isn't set, everything behaves exactly as before
  (single site, using `iisExpressPath` / `sitePath` / `port` directly).

### Choosing a profile

If your `.slnLaunch` file has more than one saved profile, click the
**Profile: ...** item in the status bar (or run
`MSBuild Remote: Select Launch Profile` from the Command Palette) to pick
which one to use. Your choice is remembered per-workspace and takes
priority over `slnLaunchProfile` in the config file, so you can switch
between profiles (e.g. "Web only" vs "Web + API") without editing JSON each
time. Precedence, highest first:

1. Profile picked via the status bar / command (remembered until changed)
2. `slnLaunchProfile` in `.msbuildremote.json`
3. The first profile listed in the `.slnLaunch` file

The status bar item only appears when `slnLaunchFile` is set, and updates
automatically if you edit the config or the `.slnLaunch` file directly.

## Why UNC paths instead of a mapped drive letter

Drive letters mapped with `net use` inside an interactive desktop session
(e.g. `Z:`) are scoped to that logon session and won't be visible to a
separate SSH logon session. Using the UNC path directly
(`\\Mac\Home\path\to\project`) avoids that mismatch entirely and works the
same regardless of which session runs the command.

## Drive mappings (for postbuild events that reject UNC paths)

UNC paths work for most projects, but some tools invoked from a postbuild
event can't handle one directly - notably `cmd.exe`, which fails to `cd`
into a UNC path at all ("CMD does not support UNC paths as current
directory"), so any postbuild event that starts with an implicit or
explicit `cd` breaks even though the build itself succeeds.

If you hit that, set `driveMappings` in `.msbuildremote.json` and point
`solutionPath`/`sitePath`/etc. at the mapped drive letter instead of the UNC
path:

```json
"driveMappings": [
  { "drive": "Z", "uncPath": "\\\\Mac\\Home\\" }
]
```

Each entry runs as `net use Z: \\Mac\Home\ /persistent:no` inline, in the
same SSH invocation as the Build or Run command that follows it - this is
what keeps the mapping visible to that command despite the per-session
scoping described above, without leaving a stale mapping behind afterwards.
Add more entries to map multiple drives. Any existing mapping on the same
letter is dropped first, so it's safe to leave configured across runs even
if the letter is already mapped to something else.

## Skipping pre/post-build events

By default this extension blanks out every project's `PreBuildEvent` and
`PostBuildEvent` for each Build (via `/p:PreBuildEvent=` /
`/p:PostBuildEvent=`), so they never run at all. Most of these events were
written to do something on the machine Visual Studio itself runs on -
copying to a local path, launching a local tool - and either fail outright
against the remote Windows VM or do something pointless there. Skipping
them sidesteps that entirely, as an alternative to fixing each one (e.g.
with `driveMappings` above).

If you need them to actually run, set `"skipBuildEvents": false` in
`.msbuildremote.json`.

## SSH key setup (recommended)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/parallels_vm
# copy the .pub key contents into, on the Windows VM:
#   C:\Users\<user>\.ssh\authorized_keys      (non-admin account)
#   C:\ProgramData\ssh\administrators_authorized_keys   (admin account)
```

Point `identityFile` in the config at the private key path and you won't be
prompted for a password when clicking Build/Run.

## Notes

- The Run button keeps the SSH connection open in a VS Code terminal so
  IIS Express output streams live; closing that terminal or pressing
  `Ctrl+C` ends the remote process. Use **Stop** if the terminal was closed
  without doing that.
- Firewall and hostname-binding setup for `http://<host>:<port>` access from
  macOS is handled automatically before each Run - see below.

## Remote setup for Run

Reaching a site at `http://<host>:<port>` from macOS needs two things on the
Windows VM that aren't set up by default: an inbound firewall rule for that
port, and an IIS Express binding that accepts a Host header other than
`localhost` (without it, IIS Express returns `Bad Request - Invalid
Hostname` for any request that isn't addressed to literally `localhost`).

Before each Run, this extension SSHes in and runs a PowerShell script that,
for every site about to be started, idempotently:

1. Adds a `New-NetFirewallRule` allowing inbound TCP on that port (named
   `MSBuildRemote-<port>`, skipped if it already exists).
2. Reserves the http.sys URL ACL for `http://*:<port>/` via
   `netsh http add urlacl` - required for IIS Express to bind to anything
   other than `localhost` without running elevated (skipped if already
   reserved).
3. (Re)writes a standalone
   `%USERPROFILE%\Documents\IISExpress\config\msbuildremote.applicationhost.config`
   containing one `<site>` per project, each bound with a blank hostname
   (`*:<port>:` - "All Unassigned", meaning any Host header is accepted).
   Run then launches IIS Express against this file with `/site` + `/config`
   instead of its usual ad hoc `/path` + `/port`. That's a deliberate
   difference: ad hoc mode regenerates its own temporary site - hostname
   binding included - on every single launch, so anything that pre-patches
   its binding (an earlier version of this feature did) gets silently
   overwritten the moment IIS Express starts; a standalone config it's
   simply told to load isn't touched by that.

This requires the SSH account to be an administrator (see
[SSH key setup](#ssh-key-setup-recommended) above) - non-interactive SSH/PowerShell
sessions aren't subject to UAC token filtering, so an administrator account
gets full privileges without extra prompts. If the account isn't an
administrator, these steps fail with a warning in the output channel but
Run still attempts to start the site(s) anyway.

Set `"autoConfigureRemote": false` in `.msbuildremote.json` to skip this and
manage firewall/binding setup yourself - Run then falls back to launching
IIS Express in its ordinary ad hoc `/path`/`/port` mode.
