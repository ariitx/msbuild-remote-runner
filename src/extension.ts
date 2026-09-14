import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const CONFIG_FILENAME = '.msbuildremote.json';

interface DriveMapping {
  // Drive letter to map, e.g. "Z" or "Z:".
  drive: string;
  // UNC path to map it to, e.g. "\\Mac\Home\".
  uncPath: string;
}

interface SiteConfig {
  // Must match (or be a suffix of) a "Path" entry in the .slnLaunch file,
  // e.g. "WebApplication\\WebApplication.csproj".
  projectPath: string;
  // Optional friendly name for terminals/logs. Defaults to projectPath.
  name?: string;
  // Falls back to the top-level iisExpressPath if omitted.
  iisExpressPath?: string;
  sitePath: string;
  port: number;
}

interface MsbuildRemoteConfig {
  host: string;
  user: string;
  identityFile?: string;
  msbuildPath: string;
  solutionPath: string;
  configuration: string;
  // Optional MSBuild platform (e.g. "Any CPU", "x86", "x64"), passed as
  // /p:Platform. Omitted by default so MSBuild falls back to the project's
  // own default. Overridden at runtime by "Select Configuration/Platform".
  platform?: string;
  target: string;
  // Single-site mode (used when no .slnLaunch/.slnLaunch.user file is
  // found or configured).
  iisExpressPath?: string;
  sitePath?: string;
  port?: number;
  // Multi-site mode: normally auto-detected by scanning the workspace for
  // a .slnLaunch or .slnLaunch.user file. Set this only to override that
  // auto-detection (e.g. multiple solutions in one workspace), as a path
  // relative to the workspace root.
  slnLaunchFile?: string;
  // Name of the profile to use. Defaults to the first profile in the file.
  slnLaunchProfile?: string;
  // Optional per-project overrides. Each enabled project in the chosen
  // profile is matched against this list first; if there's no match, its
  // sitePath/port are auto-derived from the <IISUrl> in its .csproj (or
  // .csproj.user).
  sites?: SiteConfig[];
  // Before each Run, SSH in and (idempotently) open the Windows Firewall for
  // each site's port, reserve the http.sys URL ACL for a wildcard-hostname
  // binding, and patch IIS Express's applicationhost.config so its binding
  // accepts any Host header instead of just "localhost". Requires the SSH
  // account to be an administrator (see README). Defaults to true; set to
  // false to skip it (e.g. if you've configured this by hand already).
  autoConfigureRemote?: boolean;
  // Remaps one or more network drives before each SSH command that touches
  // the solution/site (Build and Run), by running `net use` inline as part
  // of the same SSH invocation. Some postbuild events / tools fail against
  // a UNC path directly (e.g. cmd.exe can't `cd` into one), so a mapped
  // drive letter is needed for those even though UNC paths otherwise avoid
  // the per-session drive-mapping mismatch (see README). Any existing
  // mapping for the same drive letter is dropped first, so this is safe to
  // re-run on every command.
  driveMappings?: DriveMapping[];
}

interface SlnLaunchProject {
  Path: string;
  Action: 'Start' | 'StartWithoutDebugging' | 'None' | string;
}

interface SlnLaunchProfile {
  Name: string;
  Projects: SlnLaunchProject[];
}

const DEFAULT_CONFIG: MsbuildRemoteConfig = {
  host: '10.211.55.3',
  user: 'ari',
  identityFile: '~/.ssh/parallels_vm',
  msbuildPath:
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe',
  solutionPath:
    '\\\\Mac\\Home\\path\\to\\YourProject\\YourProject.sln',
  configuration: 'Release',
  target: 'Rebuild',
  iisExpressPath: 'C:\\Program Files\\IIS Express\\iisexpress.exe',
  sitePath: '\\\\Mac\\Home\\path\\to\\YourProject',
  port: 8080
  // To use a .slnLaunch file instead of single-site mode, add:
  // "slnLaunchFile": "YourProject.slnLaunch.user",
  // "slnLaunchProfile": "Feature Profile",
  // "sites": [
  //   {
  //     "projectPath": "YourWeb\\YourWeb.csproj",
  //     "sitePath": "\\\\Mac\\Home\\path\\to\\YourWeb",
  //     "port": 8080
  //   },
  //   {
  //     "projectPath": "YourApi\\YourApi.csproj",
  //     "sitePath": "\\\\Mac\\Home\\path\\to\\YourApi",
  //     "port": 8081
  //   }
  // ]
  //
  // If a postbuild event fails against a UNC path (e.g. cmd.exe can't `cd`
  // into one), map drive letter(s) before each Build/Run command:
  // "driveMappings": [
  //   { "drive": "Z", "uncPath": "\\\\Mac\\Home\\" }
  // ]
};

let outputChannel: vscode.OutputChannel;
const runTerminals: Map<string, vscode.Terminal> = new Map();
let activePorts: number[] = [];
let statusBarBuild: vscode.StatusBarItem;
let statusBarBuildProfile: vscode.StatusBarItem;
let statusBarRun: vscode.StatusBarItem;
let statusBarStop: vscode.StatusBarItem;
let statusBarProfile: vscode.StatusBarItem;
let statusBarConfig: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;

const SELECTED_PROFILE_KEY = 'msbuildRemote.selectedProfile';
const SELECTED_CONFIGURATION_KEY = 'msbuildRemote.selectedConfiguration';
const SELECTED_PLATFORM_KEY = 'msbuildRemote.selectedPlatform';

const FALLBACK_CONFIG_PLATFORM_COMBOS: { configuration: string; platform: string }[] = [
  { configuration: 'Debug', platform: 'Any CPU' },
  { configuration: 'Release', platform: 'Any CPU' },
  { configuration: 'Debug', platform: 'x86' },
  { configuration: 'Release', platform: 'x86' },
  { configuration: 'Debug', platform: 'x64' },
  { configuration: 'Release', platform: 'x64' }
];

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel('MSBuild Remote');

  statusBarBuild = createStatusBarItem('$(tools) Build', 'msbuildRemote.build', 100);
  statusBarBuildProfile = createStatusBarItem(
    '$(package) Build Profile',
    'msbuildRemote.buildProfile',
    99.5
  );
  statusBarRun = createStatusBarItem('$(play) Run', 'msbuildRemote.run', 99);
  statusBarStop = createStatusBarItem('$(debug-stop) Stop', 'msbuildRemote.stop', 98);
  statusBarProfile = createStatusBarItem(
    '$(list-selection) Profile: (auto)',
    'msbuildRemote.selectLaunchProfile',
    97
  );
  statusBarConfig = createStatusBarItem(
    '$(gear) Config: (auto)',
    'msbuildRemote.selectConfiguration',
    96.5
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('msbuildRemote.build', () => runBuild(false)),
    vscode.commands.registerCommand('msbuildRemote.buildProfile', () => runBuild(true)),
    vscode.commands.registerCommand('msbuildRemote.run', runApp),
    vscode.commands.registerCommand('msbuildRemote.stop', stopApp),
    vscode.commands.registerCommand('msbuildRemote.openConfig', openConfig),
    vscode.commands.registerCommand('msbuildRemote.selectLaunchProfile', selectLaunchProfile),
    vscode.commands.registerCommand('msbuildRemote.selectConfiguration', selectConfiguration),
    statusBarBuild,
    statusBarBuildProfile,
    statusBarRun,
    statusBarStop,
    statusBarProfile,
    statusBarConfig,
    outputChannel
  );

  ensureConfigExists();
  updateStatusBarVisibility();

  // Keep the "Profile:" status bar item in sync if the user edits
  // .msbuildremote.json or the .slnLaunch file directly.
  const watcher = vscode.workspace.createFileSystemWatcher('**/{.msbuildremote.json,*.slnLaunch,*.slnLaunch.user}');
  watcher.onDidChange(refreshProfileStatusBar);
  watcher.onDidCreate(refreshProfileStatusBar);
  watcher.onDidDelete(refreshProfileStatusBar);
  context.subscriptions.push(watcher);

  // Keep all status bar items hidden/shown in sync with whether the
  // workspace actually contains a VS solution/project file.
  const vsProjectWatcher = vscode.workspace.createFileSystemWatcher(
    '**/*.{sln,csproj,vbproj,fsproj,vcxproj}'
  );
  vsProjectWatcher.onDidCreate(updateStatusBarVisibility);
  vsProjectWatcher.onDidDelete(updateStatusBarVisibility);
  // A .sln's configuration/platform combos can change on edit too (not just
  // create/delete), so the "Config:" status bar item needs to notice those.
  vsProjectWatcher.onDidChange(refreshConfigStatusBar);
  context.subscriptions.push(vsProjectWatcher);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(updateStatusBarVisibility));
}

export function deactivate() {
  runTerminals.forEach((t) => t.dispose());
}

function createStatusBarItem(
  text: string,
  command: string,
  priority: number
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
  item.text = text;
  item.command = command;
  item.tooltip = command;
  return item;
}

/**
 * Shows/hides the Build/Run/Stop status bar items based on whether the
 * workspace has a VS solution/project file, and re-derives the
 * Profile/Build Profile items' visibility on top of that.
 */
function updateStatusBarVisibility() {
  if (hasVsProject()) {
    statusBarBuild.show();
    statusBarRun.show();
    statusBarStop.show();
  } else {
    statusBarBuild.hide();
    statusBarRun.hide();
    statusBarStop.hide();
  }
  refreshProfileStatusBar();
  refreshConfigStatusBar();
}

function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('MSBuild Remote: open a folder/workspace first.');
    return undefined;
  }
  return folders[0].uri.fsPath;
}

function getConfigPath(): string | undefined {
  const root = getWorkspaceRoot();
  if (!root) return undefined;
  return path.join(root, CONFIG_FILENAME);
}

/**
 * Creates the default config file, but only if the workspace actually looks
 * like an MSBuild project (has a .sln/.csproj/etc. somewhere); otherwise
 * there's nothing for this extension to do here, so it stays quiet.
 * Returns whether a config file exists at configPath after this call.
 */
function ensureConfigExists(): boolean {
  const configPath = getConfigPath();
  if (!configPath) return false;
  if (fs.existsSync(configPath)) return true;
  if (!hasVsProject()) return false;
  fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  outputChannel.appendLine(
    `Created default config at ${configPath}. Edit it before building/running.`
  );
  return true;
}

function loadConfig(): MsbuildRemoteConfig | undefined {
  const configPath = getConfigPath();
  if (!configPath) return undefined;

  if (!fs.existsSync(configPath)) {
    if (!ensureConfigExists()) {
      vscode.window.showErrorMessage(
        `MSBuild Remote: no ${CONFIG_FILENAME} found, and no .sln/.csproj (or other Visual Studio project) file was found in the workspace to generate one for.`
      );
      return undefined;
    }
    vscode.window
      .showWarningMessage(
        `MSBuild Remote: created ${CONFIG_FILENAME} with placeholder values. Edit it and try again.`,
        'Open Config'
      )
      .then((choice) => {
        if (choice === 'Open Config') openConfig();
      });
    return undefined;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as MsbuildRemoteConfig;

    const required: (keyof MsbuildRemoteConfig)[] = [
      'host',
      'user',
      'msbuildPath',
      'solutionPath',
      'configuration',
      'target'
    ];
    const missing = required.filter((key) => !parsed[key]);
    if (missing.length > 0) {
      vscode.window.showErrorMessage(
        `MSBuild Remote: ${CONFIG_FILENAME} is missing required field(s): ${missing.join(', ')}`
      );
      return undefined;
    }

    return parsed;
  } catch (err: any) {
    vscode.window.showErrorMessage(`MSBuild Remote: failed to parse ${CONFIG_FILENAME}: ${err.message}`);
    return undefined;
  }
}

function openConfig() {
  const configPath = getConfigPath();
  if (!configPath) return;
  if (!ensureConfigExists()) {
    vscode.window.showErrorMessage(
      `MSBuild Remote: no ${CONFIG_FILENAME} found, and no .sln/.csproj (or other Visual Studio project) file was found in the workspace to generate one for.`
    );
    return;
  }
  vscode.workspace.openTextDocument(configPath).then((doc) => {
    vscode.window.showTextDocument(doc);
  });
}

function sshBaseArgs(config: MsbuildRemoteConfig): string[] {
  const args: string[] = [];
  if (config.identityFile) {
    args.push('-i', config.identityFile);
  }
  args.push(`${config.user}@${config.host}`);
  return args;
}

/**
 * Builds a cmd.exe command prefix that (re-)maps each configured drive
 * letter to its UNC path before the real remote command runs, so both land
 * in the same SSH invocation/session. Each mapping first drops any existing
 * connection on that drive letter (ignoring failure, e.g. "not found") so a
 * stale or differently-targeted mapping from a previous session doesn't
 * make the `net use` below fail. Returns '' when no mappings are configured.
 */
function buildDriveMapPrefix(config: MsbuildRemoteConfig): string {
  if (!config.driveMappings || config.driveMappings.length === 0) return '';
  const commands = config.driveMappings.map((m) => {
    const drive = m.drive.replace(/:$/, '').toUpperCase();
    // A trailing backslash right before the closing quote would escape that
    // quote instead of closing the string (standard Windows argv parsing),
    // swallowing the rest of the command into the path - so it's trimmed
    // here. It's redundant in a UNC path anyway ("\\Mac\Home" and
    // "\\Mac\Home\" are equivalent).
    const uncPath = m.uncPath.replace(/\\+$/, '');
    return `(net use ${drive}: /delete /y >nul 2>&1) & net use ${drive}: "${uncPath}" /persistent:no`;
  });
  return commands.join(' & ') + ' & ';
}

interface RemoteSetupSite {
  port: number;
  sitePath: string;
}

/**
 * IIS Express's ad hoc "/path /port" invocation regenerates its temporary
 * "Development Web Site" definition - hostname binding included - on every
 * single launch, so pre-patching applicationhost.config to accept a Host
 * header other than "localhost" gets silently clobbered the moment IIS
 * Express starts. To make the fix actually stick, launchSite() avoids ad hoc
 * mode altogether and instead points IIS Express at a standalone config file
 * this extension owns, via "/site" + "/config". These two helpers name that
 * site and locate that file, in the syntax each remote shell expects them in
 * (cmd.exe for the site launch, PowerShell for the setup script).
 */
function remoteSiteName(port: number): string {
  return `MSBuildRemote-${port}`;
}
const REMOTE_CUSTOM_CONFIG_CMD = '%USERPROFILE%\\Documents\\IISExpress\\config\\msbuildremote.applicationhost.config';

/**
 * Builds a PowerShell script that, given the full set of sites this Run is
 * about to start:
 *  - opens the Windows Firewall for inbound TCP on each port (idempotent)
 *  - reserves the http.sys URL ACL for a wildcard-hostname binding on each
 *    port via netsh (idempotent) - binding IIS Express to anything other
 *    than "localhost" needs this, or the process would need to run elevated
 *  - (re)writes msbuildremote.applicationhost.config: a standalone config
 *    copied from an existing IIS Express applicationhost.config (so it
 *    carries the schema/modules/apppool sections IIS Express requires),
 *    with its <sites> replaced by exactly these sites, each bound with a
 *    blank hostname ("All Unassigned" - matches any Host header, unlike ad
 *    hoc mode's hardcoded "localhost")
 * Piped to PowerShell over stdin rather than embedded in the remote command
 * string (see runRemoteSetup), so this can be a normal multi-line script -
 * no single-line/quoting gymnastics or command-length limit needed.
 */
function buildRemoteSetupScript(sites: RemoteSetupSite[]): string {
  const siteEntries = sites
    .map(
      (s) =>
        `[pscustomobject]@{ Port = ${s.port}; Name = '${remoteSiteName(s.port)}'; Path = '${s.sitePath.replace(/'/g, "''")}' }`
    )
    .join(",\n  ");

  return `
\$sites = @(
  ${siteEntries}
)

foreach (\$s in \$sites) {
  \$fw = 'MSBuildRemote-' + \$s.Port
  if (-not (Get-NetFirewallRule -DisplayName \$fw -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName \$fw -Direction Inbound -Protocol TCP -LocalPort \$s.Port -Action Allow | Out-Null
  }
  \$url = 'http://*:' + \$s.Port + '/'
  \$existing = netsh http show urlacl url=\$url
  if (\$existing -notmatch 'Reserved URL') {
    netsh http add urlacl url=\$url user=Everyone | Out-Null
  }
}

\$configDir = Join-Path \$env:USERPROFILE 'Documents\\IISExpress\\config'
New-Item -ItemType Directory -Force -Path \$configDir | Out-Null
\$customConfig = Join-Path \$configDir 'msbuildremote.applicationhost.config'

# Prefer the per-user config ad hoc mode itself already reads/writes - it's
# guaranteed to have valid schema/apppools sections if it exists at all,
# without needing to guess which IIS Express version's install layout to
# read a shipped template from. Only fall back to the installer's own
# template (path varies by version) if that per-user file isn't there yet
# (e.g. IIS Express has never been run on this machine before).
\$template = Join-Path \$configDir 'applicationhost.config'
if (-not (Test-Path \$template)) {
  \$template = Join-Path \$env:ProgramFiles 'IIS Express\\config\\templates\\PersonalWebServer\\applicationhost.config'
}
if (-not (Test-Path \$template)) {
  \$template = Join-Path \${env:ProgramFiles(x86)} 'IIS Express\\config\\templates\\PersonalWebServer\\applicationhost.config'
}
if (-not (Test-Path \$template)) {
  Write-Output 'MSBuildRemote: could not find an IIS Express applicationhost.config to base the binding fix on; skipping. Run the site once first (even if it shows Bad Request), then Run again.'
  exit 0
}

[xml]\$xml = Get-Content -Path \$template -Raw
\$appHost = \$xml.configuration.'system.applicationHost'
\$sitesNode = \$appHost.sites
\$poolName = @(\$appHost.applicationPools.add)[0].name

foreach (\$old in @(\$sitesNode.site)) {
  \$sitesNode.RemoveChild(\$old) | Out-Null
}

\$id = 1
foreach (\$s in \$sites) {
  \$site = \$xml.CreateElement('site')
  \$site.SetAttribute('name', \$s.Name)
  \$site.SetAttribute('id', \$id)
  \$site.SetAttribute('serverAutoStart', 'true')

  \$app = \$xml.CreateElement('application')
  \$app.SetAttribute('path', '/')
  \$app.SetAttribute('applicationPool', \$poolName)

  \$vdir = \$xml.CreateElement('virtualDirectory')
  \$vdir.SetAttribute('path', '/')
  \$vdir.SetAttribute('physicalPath', \$s.Path)
  \$app.AppendChild(\$vdir) | Out-Null
  \$site.AppendChild(\$app) | Out-Null

  \$bindings = \$xml.CreateElement('bindings')
  \$binding = \$xml.CreateElement('binding')
  \$binding.SetAttribute('protocol', 'http')
  \$binding.SetAttribute('bindingInformation', '*:' + \$s.Port + ':')
  \$bindings.AppendChild(\$binding) | Out-Null
  \$site.AppendChild(\$bindings) | Out-Null

  \$sitesNode.AppendChild(\$site) | Out-Null
  \$id++
}

\$xml.Save(\$customConfig)
Write-Output 'MSBuildRemote: remote setup complete.'
`;
}

/**
 * Runs buildRemoteSetupScript() over SSH and waits for it to finish before
 * Run proceeds to launch IIS Express. The script is piped over the SSH
 * connection's stdin to "powershell -Command -" (which reads its script
 * from stdin) rather than passed as part of the remote command string -
 * sshd on Windows runs that string through cmd.exe /c, whose ~8KB
 * command-line limit a multi-site -EncodedCommand payload could otherwise
 * approach; stdin has no such ceiling.
 * Failures are logged but non-fatal - the account might not be an
 * administrator, or this might already be configured from a previous run -
 * so Run still attempts to start the site(s) afterwards either way.
 */
function runRemoteSetup(config: MsbuildRemoteConfig, sites: RemoteSetupSite[]): Promise<void> {
  return new Promise((resolve) => {
    if (sites.length === 0) {
      resolve();
      return;
    }

    const script = buildRemoteSetupScript(sites);
    const remoteCommand = 'powershell -NoProfile -Command -';
    const args = [...sshBaseArgs(config), remoteCommand];

    outputChannel.appendLine(
      `Configuring remote firewall/binding for port(s) ${sites.map((s) => s.port).join(', ')}...`
    );

    const proc = spawn('ssh', args);
    proc.stdin.write(script);
    proc.stdin.end();
    proc.stdout.on('data', (data) => outputChannel.append(data.toString()));
    proc.stderr.on('data', (data) => outputChannel.append(data.toString()));
    proc.on('close', (code) => {
      if (code !== 0) {
        outputChannel.appendLine(
          `[warn] remote setup exited with code ${code}. Continuing anyway - ` +
            `the site may still fail to load remotely if the account isn't an administrator. ` +
            `See README for the manual fix.`
        );
      }
      resolve();
    });
    proc.on('error', (err) => {
      outputChannel.appendLine(`[warn] failed to run remote setup: ${err.message}`);
      resolve();
    });
  });
}

/**
 * Resolves an .slnLaunch project's (solution-relative) Path to the absolute
 * Windows path MSBuild needs, by joining it onto the remote solution's
 * directory.
 */
function resolveProjectWindowsPath(config: MsbuildRemoteConfig, projectPath: string): string {
  const solutionDirWindows = path.win32.dirname(config.solutionPath);
  return `${solutionDirWindows}\\${projectPath.replace(/\//g, '\\')}`;
}

function runBuild(profileOnly: boolean) {
  const config = loadConfig();
  if (!config) return;

  let projectPaths: string[];
  let label: string;

  if (profileOnly) {
    if (!getSlnLaunchPath(config)) {
      vscode.window.showErrorMessage(
        `MSBuild Remote: no .slnLaunch/.slnLaunch.user file found, so there's no profile to build. Use "Build" to build the whole solution.`
      );
      return;
    }
    const projects = resolveSlnLaunchProjects(config);
    if (!projects) return;
    if (projects.length === 0) {
      vscode.window.showWarningMessage('MSBuild Remote: the selected profile has no enabled projects to build.');
      return;
    }
    projectPaths = projects.map((p) => resolveProjectWindowsPath(config, p.Path));
    const profileName = getEffectiveProfileName(config, readSlnLaunchProfilesQuiet(config) || []);
    label = `profile "${profileName}" (${projects.length} project(s))`;
  } else {
    projectPaths = [config.solutionPath];
    label = 'solution';
  }

  const configuration = getEffectiveConfiguration(config);
  const platform = getEffectivePlatform(config);
  const platformArg = platform ? ` /p:Platform="${platform}"` : '';

  // Chained with "&&" (not "&") so a failed project stops the build and its
  // exit code is the one ssh/this function ultimately sees.
  const buildCommands = projectPaths
    .map(
      (p) =>
        `"${config.msbuildPath}" "${p}" /p:Configuration="${configuration}"${platformArg} /t:${config.target}`
    )
    .join(' && ');
  const remoteCommand = `${buildDriveMapPrefix(config)}${buildCommands}`;
  const args = [...sshBaseArgs(config), remoteCommand];

  outputChannel.clear();
  outputChannel.show(true);
  outputChannel.appendLine(`Building ${label}...`);
  outputChannel.appendLine(`$ ssh ${args.join(' ')}`);
  outputChannel.appendLine('');

  const statusBarItem = profileOnly ? statusBarBuildProfile : statusBarBuild;
  const idleText = profileOnly ? '$(package) Build Profile' : '$(tools) Build';
  statusBarItem.text = '$(sync~spin) Building...';

  const proc = spawn('ssh', args);

  proc.stdout.on('data', (data) => outputChannel.append(data.toString()));
  proc.stderr.on('data', (data) => outputChannel.append(data.toString()));

  proc.on('close', (code) => {
    statusBarItem.text = idleText;
    if (code === 0) {
      outputChannel.appendLine('\n[Build finished: succeeded]');
      vscode.window.showInformationMessage(`MSBuild Remote: build succeeded (${label}).`);
    } else {
      outputChannel.appendLine(`\n[Build finished: exit code ${code}]`);
      vscode.window.showErrorMessage(`MSBuild Remote: build failed (exit code ${code}). See "MSBuild Remote" output.`);
    }
  });

  proc.on('error', (err) => {
    statusBarItem.text = idleText;
    vscode.window.showErrorMessage(`MSBuild Remote: failed to start ssh: ${err.message}`);
  });
}

function normalizeWinPath(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase();
}

const IGNORED_DIR_NAMES = new Set(['node_modules', '.git', 'bin', 'obj', 'out', '.vs', 'packages']);

/**
 * Iteratively walks `dir` up to `maxDepth` levels deep, skipping noisy
 * directories (node_modules, bin, obj, etc.), collecting files whose name
 * matches `matches`.
 */
function walkForFiles(dir: string, matches: (name: string) => boolean, maxDepth: number): string[] {
  const results: string[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir, depth: 0 }];

  while (stack.length > 0) {
    const { dir: current, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth >= maxDepth || IGNORED_DIR_NAMES.has(entry.name)) continue;
        stack.push({ dir: path.join(current, entry.name), depth: depth + 1 });
      } else if (matches(entry.name)) {
        results.push(path.join(current, entry.name));
      }
    }
  }

  return results;
}

const VS_PROJECT_FILE_RE = /\.(sln|csproj|vbproj|fsproj|vcxproj)$/i;

/**
 * Whether any workspace folder contains a Visual Studio solution or project
 * file. The status bar items are only useful for MSBuild-based projects, so
 * they're hidden entirely otherwise instead of cluttering every workspace.
 */
function hasVsProject(): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return false;
  return folders.some(
    (f) => walkForFiles(f.uri.fsPath, (name) => VS_PROJECT_FILE_RE.test(name), 3).length > 0
  );
}

/**
 * Scans the workspace for a .slnLaunch / .slnLaunch.user file so users
 * don't have to point "slnLaunchFile" at it manually. Prefers a ".user"
 * file (the local, per-developer startup-project selection VS actually
 * launches from) over a shared ".slnLaunch", and prefers shallower matches
 * when more than one is found.
 */
function findSlnLaunchFileAuto(root: string): string | undefined {
  const matches = walkForFiles(root, (name) => /\.slnlaunch(\.user)?$/i.test(name), 3);
  if (matches.length === 0) return undefined;

  matches.sort((a, b) => {
    const aIsUser = a.toLowerCase().endsWith('.slnlaunch.user') ? 0 : 1;
    const bIsUser = b.toLowerCase().endsWith('.slnlaunch.user') ? 0 : 1;
    if (aIsUser !== bIsUser) return aIsUser - bIsUser;
    return a.split(path.sep).length - b.split(path.sep).length;
  });

  return matches[0];
}

function getSlnLaunchPath(config: MsbuildRemoteConfig): string | undefined {
  const root = getWorkspaceRoot();
  if (!root) return undefined;
  if (config.slnLaunchFile) {
    return path.isAbsolute(config.slnLaunchFile)
      ? config.slnLaunchFile
      : path.join(root, config.slnLaunchFile);
  }
  return findSlnLaunchFileAuto(root);
}

/**
 * Reads the <IISUrl> that Visual Studio's Web project properties write for
 * a project, to recover its IIS Express port without it needing a manual
 * "sites" entry. That setting normally lives in the .csproj itself, under
 * ProjectExtensions/VisualStudio/FlavorProperties/WebProjectProperties, but
 * if "Save server settings in user file" was checked it ends up in the
 * sibling .csproj.user file instead — so that's checked first since it
 * reflects the developer's actual local port more often than a shared
 * .csproj would.
 */
function extractIisPortFromCsproj(csprojLocalPath: string): number | undefined {
  for (const file of [`${csprojLocalPath}.user`, csprojLocalPath]) {
    if (!fs.existsSync(file)) continue;
    const xml = fs.readFileSync(file, 'utf8');
    const match = xml.match(/<IISUrl>\s*([^<]+?)\s*<\/IISUrl>/i);
    if (!match) continue;
    const portMatch = match[1].match(/:(\d+)/);
    if (portMatch) return parseInt(portMatch[1], 10);
  }
  return undefined;
}

/**
 * Derives a SiteConfig for a .slnLaunch project straight from its .csproj,
 * used when there's no matching manual entry in "sites". The project's
 * local path is resolved relative to `solutionDirLocal` - the directory the
 * .slnLaunch file itself was found in, which sits next to the .sln and is
 * NOT necessarily the workspace root (a workspace can be opened one or more
 * levels above the solution). Its Windows-side sitePath is derived from
 * "solutionPath" so it doesn't need to be typed out per project either.
 */
function resolveSiteFromCsproj(
  config: MsbuildRemoteConfig,
  solutionDirLocal: string,
  project: SlnLaunchProject
): SiteConfig | undefined {
  const csprojLocal = path.join(solutionDirLocal, project.Path.replace(/\\/g, path.sep));
  if (!fs.existsSync(csprojLocal)) return undefined;

  const port = extractIisPortFromCsproj(csprojLocal);
  if (!port) return undefined;

  const solutionDirWindows = path.win32.dirname(config.solutionPath);
  const projectDirWindows = path.win32.dirname(project.Path);
  const sitePath =
    projectDirWindows === '.' ? solutionDirWindows : `${solutionDirWindows}\\${projectDirWindows}`;

  return {
    projectPath: project.Path,
    name: path.win32.basename(project.Path, '.csproj'),
    sitePath,
    port
  };
}

/**
 * Reads and parses the raw list of profiles from the .slnLaunch /
 * .slnLaunch.user file. The file lives inside the shared project folder,
 * so it's read straight off the Mac filesystem — no SSH round trip needed
 * just to parse it.
 */
function readSlnLaunchProfiles(config: MsbuildRemoteConfig): SlnLaunchProfile[] | undefined {
  const slnLaunchPath = getSlnLaunchPath(config);
  if (!slnLaunchPath) return undefined;

  if (!fs.existsSync(slnLaunchPath)) {
    vscode.window.showErrorMessage(`MSBuild Remote: .slnLaunch file not found at ${slnLaunchPath}`);
    return undefined;
  }

  try {
    const profiles = JSON.parse(fs.readFileSync(slnLaunchPath, 'utf8'));
    if (!Array.isArray(profiles) || profiles.length === 0) {
      vscode.window.showErrorMessage(`MSBuild Remote: ${slnLaunchPath} has no launch profiles.`);
      return undefined;
    }
    return profiles;
  } catch (err: any) {
    vscode.window.showErrorMessage(`MSBuild Remote: failed to parse ${slnLaunchPath}: ${err.message}`);
    return undefined;
  }
}

/**
 * Resolves which profile name to actually use: an interactively-picked
 * profile (via the status bar / command) takes priority, then falls back
 * to "slnLaunchProfile" in the config file, then the first profile found.
 */
function getEffectiveProfileName(config: MsbuildRemoteConfig, profiles: SlnLaunchProfile[]): string {
  if (!profiles || profiles.length === 0) return '(auto)';
  const picked = extensionContext?.workspaceState.get<string>(SELECTED_PROFILE_KEY);
  if (picked && profiles.some((p) => p.Name === picked)) {
    return picked;
  }
  if (config.slnLaunchProfile && profiles.some((p) => p.Name === config.slnLaunchProfile)) {
    return config.slnLaunchProfile;
  }
  return profiles[0].Name;
}

/**
 * Resolves the effective configuration/platform: an interactively-picked
 * value (via the status bar / command) takes priority, then falls back to
 * the corresponding field(s) in the config file. Platform is omitted
 * entirely (no /p:Platform passed) when neither is set.
 */
function getEffectiveConfiguration(config: MsbuildRemoteConfig): string {
  const picked = extensionContext?.workspaceState.get<string>(SELECTED_CONFIGURATION_KEY);
  return picked || config.configuration;
}

function getEffectivePlatform(config: MsbuildRemoteConfig): string | undefined {
  const picked = extensionContext?.workspaceState.get<string>(SELECTED_PLATFORM_KEY);
  return picked || config.platform;
}

/**
 * Scans the workspace for a .sln file, the same way findSlnLaunchFileAuto()
 * looks for a .slnLaunch file - preferring the shallowest match.
 */
function findSolutionFileAuto(root: string): string | undefined {
  const matches = walkForFiles(root, (name) => /\.sln$/i.test(name), 3);
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  return matches[0];
}

/**
 * Parses the GlobalSection(SolutionConfigurationPlatforms) block of a .sln
 * file (lines like "Debug|Any CPU = Debug|Any CPU") to recover the actual
 * configuration/platform combos the solution defines, so the picker offers
 * real choices instead of a guessed list.
 */
function readSolutionConfigPlatforms(
  solutionLocalPath: string
): { configuration: string; platform: string }[] | undefined {
  if (!fs.existsSync(solutionLocalPath)) return undefined;

  const text = fs.readFileSync(solutionLocalPath, 'utf8');
  const sectionMatch = text.match(
    /GlobalSection\(SolutionConfigurationPlatforms\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/
  );
  if (!sectionMatch) return undefined;

  const combos: { configuration: string; platform: string }[] = [];
  const seen = new Set<string>();
  const lineRe = /^\s*([^=\r\n]+?)\s*=\s*[^=\r\n]+?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(sectionMatch[1])) !== null) {
    const pipeIdx = m[1].indexOf('|');
    if (pipeIdx === -1) continue;
    const configuration = m[1].slice(0, pipeIdx).trim();
    const platform = m[1].slice(pipeIdx + 1).trim();
    const key = `${configuration}|${platform}`;
    if (seen.has(key)) continue;
    seen.add(key);
    combos.push({ configuration, platform });
  }

  return combos.length > 0 ? combos : undefined;
}

interface ConfigPlatformQuickPickItem extends vscode.QuickPickItem {
  configuration: string;
  platform: string;
}

async function selectConfiguration() {
  const config = loadConfig();
  if (!config) return;
  const root = getWorkspaceRoot();
  if (!root) return;

  const solutionLocalPath = findSolutionFileAuto(root);
  const combos =
    (solutionLocalPath && readSolutionConfigPlatforms(solutionLocalPath)) || FALLBACK_CONFIG_PLATFORM_COMBOS;

  const currentConfiguration = getEffectiveConfiguration(config);
  const currentPlatform = getEffectivePlatform(config);

  const items: ConfigPlatformQuickPickItem[] = combos.map((c) => ({
    label: `${c.configuration} | ${c.platform}`,
    description:
      c.configuration === currentConfiguration && c.platform === currentPlatform ? 'current' : undefined,
    configuration: c.configuration,
    platform: c.platform
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select an MSBuild configuration/platform'
  });
  if (!picked) return;

  await extensionContext.workspaceState.update(SELECTED_CONFIGURATION_KEY, picked.configuration);
  await extensionContext.workspaceState.update(SELECTED_PLATFORM_KEY, picked.platform);
  refreshConfigStatusBar();
  vscode.window.showInformationMessage(
    `MSBuild Remote: using configuration "${picked.configuration}|${picked.platform}".`
  );
}

function refreshConfigStatusBar() {
  if (!statusBarConfig) return;
  if (!hasVsProject()) {
    statusBarConfig.hide();
    return;
  }
  const config = loadConfigQuiet();
  if (!config) {
    statusBarConfig.hide();
    return;
  }
  const configuration = getEffectiveConfiguration(config);
  const platform = getEffectivePlatform(config);
  statusBarConfig.text = `$(gear) ${configuration}${platform ? ' | ' + platform : ''}`;
  statusBarConfig.show();
}

function refreshProfileStatusBar() {
  if (!statusBarProfile) return;
  if (!hasVsProject()) {
    statusBarProfile.hide();
    statusBarBuildProfile?.hide();
    return;
  }
  const config = loadConfigQuiet();
  if (!config || !getSlnLaunchPath(config)) {
    statusBarProfile.hide();
    statusBarBuildProfile?.hide();
    return;
  }
  const profiles = readSlnLaunchProfilesQuiet(config);
  const name = profiles ? getEffectiveProfileName(config, profiles) : '(auto)';
  statusBarProfile.text = `$(list-selection) Profile: ${name}`;
  statusBarProfile.show();
  statusBarBuildProfile?.show();
}

// Silent variants used for background status-bar refresh, so they don't pop
// error dialogs while the user is just typing in their config file.
function loadConfigQuiet(): MsbuildRemoteConfig | undefined {
  const configPath = getConfigPath();
  if (!configPath || !fs.existsSync(configPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return undefined;
  }
}

function readSlnLaunchProfilesQuiet(config: MsbuildRemoteConfig): SlnLaunchProfile[] | undefined {
  const slnLaunchPath = getSlnLaunchPath(config);
  if (!slnLaunchPath || !fs.existsSync(slnLaunchPath)) return undefined;
  try {
    const profiles = JSON.parse(fs.readFileSync(slnLaunchPath, 'utf8'));
    return Array.isArray(profiles) && profiles.length > 0 ? profiles : undefined;
  } catch {
    return undefined;
  }
}

async function selectLaunchProfile() {
  const config = loadConfig();
  if (!config) return;

  if (!getSlnLaunchPath(config)) {
    vscode.window.showInformationMessage(
      `MSBuild Remote: no .slnLaunch/.slnLaunch.user file found in the workspace. Add one, or set "slnLaunchFile" in ${CONFIG_FILENAME}, to enable profile selection.`
    );
    return;
  }

  const profiles = readSlnLaunchProfiles(config);
  if (!profiles) return;

  const currentName = getEffectiveProfileName(config, profiles);
  const picked = await vscode.window.showQuickPick(
    profiles.map((p) => ({
      label: p.Name,
      description: p.Name === currentName ? 'current' : undefined,
      detail: `${(p.Projects || []).filter((proj) => proj.Action !== 'None').length} project(s) enabled`
    })),
    { placeHolder: 'Select an MSBuild Remote launch profile' }
  );

  if (!picked) return;

  await extensionContext.workspaceState.update(SELECTED_PROFILE_KEY, picked.label);
  refreshProfileStatusBar();
  vscode.window.showInformationMessage(`MSBuild Remote: using launch profile "${picked.label}".`);
}

/**
 * Returns the projects in the effective profile whose Action is not "None".
 */
function resolveSlnLaunchProjects(config: MsbuildRemoteConfig): SlnLaunchProject[] | undefined {
  const profiles = readSlnLaunchProfiles(config);
  if (!profiles) return undefined;

  const profileName = getEffectiveProfileName(config, profiles);
  const profile = profiles.find((p) => p.Name === profileName);
  if (!profile) {
    vscode.window.showErrorMessage(`MSBuild Remote: profile "${profileName}" not found.`);
    return undefined;
  }

  return (profile.Projects || []).filter((p) => p.Action !== 'None');
}

function findSiteForProject(config: MsbuildRemoteConfig, project: SlnLaunchProject): SiteConfig | undefined {
  const target = normalizeWinPath(project.Path);
  return (config.sites || []).find((site) => {
    const candidate = normalizeWinPath(site.projectPath);
    return target === candidate || target.endsWith(candidate);
  });
}

function launchSite(config: MsbuildRemoteConfig, site: SiteConfig, terminalKey: string) {
  const iisExpressPath = site.iisExpressPath || config.iisExpressPath;
  if (!iisExpressPath) {
    outputChannel.appendLine(
      `[skip] ${terminalKey}: no iisExpressPath set (neither on the site entry nor top-level config).`
    );
    return;
  }

  // With auto-configure on, IIS Express is launched against the standalone
  // config runRemoteSetup() just wrote (see buildRemoteSetupScript) rather
  // than ad hoc "/path /port", since ad hoc mode always resets its binding
  // to "localhost" on launch. Falls back to ad hoc mode when the user has
  // opted out, since no custom config exists to point at in that case.
  const iisCommand =
    config.autoConfigureRemote !== false
      ? `"${iisExpressPath}" /site:"${remoteSiteName(site.port)}" /config:"${REMOTE_CUSTOM_CONFIG_CMD}"`
      : `"${iisExpressPath}" /path:"${site.sitePath}" /port:${site.port}`;
  const remoteCommand = `${buildDriveMapPrefix(config)}${iisCommand}`;
  const identityArgs = config.identityFile ? `-i ${config.identityFile} ` : '';

  const terminalName = `MSBuild Remote: ${site.name || terminalKey}`;
  let terminal = runTerminals.get(terminalKey);
  if (!terminal || terminal.exitStatus !== undefined) {
    terminal = vscode.window.createTerminal(terminalName);
    runTerminals.set(terminalKey, terminal);
  }
  terminal.show(true);
  terminal.sendText(`ssh ${identityArgs}${config.user}@${config.host} '${remoteCommand}'`);

  activePorts.push(site.port);
}

async function runApp() {
  const config = loadConfig();
  if (!config) return;

  activePorts = [];

  // Multi-site mode: driven by a .slnLaunch / .slnLaunch.user file, found
  // automatically in the workspace unless "slnLaunchFile" overrides that.
  const slnLaunchPath = getSlnLaunchPath(config);
  if (slnLaunchPath) {
    const solutionDirLocal = path.dirname(slnLaunchPath);
    const projects = resolveSlnLaunchProjects(config);
    if (!projects) return;

    outputChannel.show(true);
    const profileName = getEffectiveProfileName(config, readSlnLaunchProfilesQuiet(config) || []);
    outputChannel.appendLine(
      `Using .slnLaunch file: ${slnLaunchPath}${config.slnLaunchFile ? '' : ' (auto-detected)'}`
    );
    outputChannel.appendLine(
      `Using slnLaunch profile "${profileName}" with ${projects.length} enabled project(s).`
    );

    const resolved: { project: SlnLaunchProject; site: SiteConfig }[] = [];

    for (const project of projects) {
      let site = findSiteForProject(config, project);
      if (!site) {
        site = resolveSiteFromCsproj(config, solutionDirLocal, project);
        if (site) {
          outputChannel.appendLine(
            `[auto] ${project.Path}: using port ${site.port} from its .csproj/.csproj.user <IISUrl>.`
          );
        }
      }
      if (!site) {
        outputChannel.appendLine(
          `[skip] ${project.Path}: no matching "sites" entry and no usable <IISUrl> found in its .csproj/.csproj.user.`
        );
        continue;
      }
      resolved.push({ project, site });
    }

    if (resolved.length === 0) {
      vscode.window.showWarningMessage(
        'MSBuild Remote: no projects were started. None had a resolvable <IISUrl> in their .csproj/.csproj.user, and none matched a "sites" entry.'
      );
      return;
    }

    if (config.autoConfigureRemote !== false) {
      await runRemoteSetup(config, resolved.map((r) => ({ port: r.site.port, sitePath: r.site.sitePath })));
    }

    const urls: string[] = [];
    for (const { project, site } of resolved) {
      launchSite(config, site, project.Path);
      urls.push(`http://${config.host}:${site.port}`);
    }

    outputChannel.appendLine(`Started ${resolved.length} site(s):\n${urls.join('\n')}`);
    vscode.window
      .showInformationMessage(
        `MSBuild Remote: started ${resolved.length} site(s). See output panel for URLs.`,
        'Open First in Browser'
      )
      .then((choice) => {
        if (choice === 'Open First in Browser' && urls.length > 0) {
          vscode.env.openExternal(vscode.Uri.parse(urls[0]));
        }
      });
    return;
  }

  // Single-site mode (no .slnLaunch file found or configured).
  if (!config.iisExpressPath || !config.sitePath || !config.port) {
    vscode.window.showErrorMessage(
      `MSBuild Remote: "iisExpressPath", "sitePath", and "port" must be set in ${CONFIG_FILENAME} to run the app.`
    );
    return;
  }

  if (config.autoConfigureRemote !== false) {
    outputChannel.show(true);
    await runRemoteSetup(config, [{ port: config.port, sitePath: config.sitePath }]);
  }

  launchSite(
    config,
    { projectPath: '', sitePath: config.sitePath, port: config.port, iisExpressPath: config.iisExpressPath },
    'default'
  );

  const url = `http://${config.host}:${config.port}`;
  vscode.window
    .showInformationMessage(`MSBuild Remote: starting site, will be at ${url}`, 'Open in Browser')
    .then((choice) => {
      if (choice === 'Open in Browser') {
        vscode.env.openExternal(vscode.Uri.parse(url));
      }
    });
}

function stopApp() {
  const config = loadConfig();
  if (!config) return;

  outputChannel.show(true);

  // Ctrl+C in each terminal is usually enough, but this covers cases where
  // the SSH session detached (e.g. a terminal was closed) and the remote
  // iisexpress.exe process is still running. Preferring a port-based kill
  // over "taskkill /IM iisexpress.exe /F" so that in multi-site mode we
  // only stop the sites this workspace started, not unrelated ones.
  const portsToKill = activePorts.length > 0 ? activePorts : config.port ? [config.port] : [];

  let remoteCommand: string;
  if (portsToKill.length > 0) {
    const perPort = portsToKill
      .map(
        (port) =>
          `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
          `Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`
      )
      .join('; ');
    remoteCommand = `powershell -NoProfile -Command "${perPort}"`;
  } else {
    // Last resort: no known ports, fall back to killing all iisexpress.exe.
    remoteCommand = 'taskkill /IM iisexpress.exe /F';
  }

  const args = [...sshBaseArgs(config), remoteCommand];
  outputChannel.appendLine(`$ ssh ${args.join(' ')}`);

  const proc = spawn('ssh', args);
  proc.stdout.on('data', (data) => outputChannel.append(data.toString()));
  proc.stderr.on('data', (data) => outputChannel.append(data.toString()));
  proc.on('close', (code) => {
    outputChannel.appendLine(`\n[Stop finished: exit code ${code}]`);
  });

  runTerminals.forEach((t) => t.dispose());
  runTerminals.clear();
  activePorts = [];
}
