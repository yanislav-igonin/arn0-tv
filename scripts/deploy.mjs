#!/usr/bin/env node
/*
 * One-command deploy: build -> sign -> install -> launch on the TV.
 *
 *   npm run deploy              full cycle
 *   npm run deploy -- --no-run  install without launching
 *
 * Local settings live in .env.local (git-ignored):
 *   TV_HOST=192.168.1.10        last known TV address (auto-updated after discovery)
 *   TV_MODEL=QA65S90FAEXZN      expected model; discovery only accepts this model
 *   TIZEN_PROFILE=my-profile    Tizen security profile used for signing
 *   TIZEN_HOME=~/tizen-studio   Tizen Studio CLI location (optional)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { networkInterfaces, homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const envFile = join(root, '.env.local');
const APP_ID = 'Arn0Lnchr0.Launcher';
const WGT = join(root, 'dist', 'arn0-launcher.wgt');
const SDB_PORT = 26101;
const args = new Set(process.argv.slice(2));

// ---------- helpers

const c = (n, s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const step = (s) => console.log(c('36', '▸ ') + s);
const ok = (s) => console.log(c('32', '✓ ') + s);
function fail(msg, hint) {
    console.error(c('31', '✗ ' + msg));
    if (hint) console.error('  ' + hint);
    process.exit(1);
}

function readEnv() {
    const env = {};
    if (!existsSync(envFile)) return env;
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
        if (m) env[m[1]] = m[2];
    }
    return env;
}

function saveEnv(key, value) {
    let text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${key}=${value}`) : text + (text && !text.endsWith('\n') ? '\n' : '') + `${key}=${value}\n`;
    writeFileSync(envFile, text);
}

let toolPath = process.env.PATH;
function run(cmd, cmdArgs, opts = {}) {
    const r = spawnSync(cmd, cmdArgs, {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
        env: { ...process.env, PATH: toolPath }, ...opts
    });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function portOpen(host, port, ms = 700) {
    return new Promise((done) => {
        const s = createConnection({ host, port });
        const end = (v) => { s.destroy(); done(v); };
        s.setTimeout(ms, () => end(false));
        s.once('connect', () => end(true));
        s.once('error', () => end(false));
    });
}

async function modelOf(host) {
    try {
        const r = await fetch(`http://${host}:8001/api/v2/`, { signal: AbortSignal.timeout(2500) });
        return (await r.json())?.device?.modelName || null;
    } catch { return null; }
}

async function isOurTv(host, model) {
    if (!(await portOpen(host, SDB_PORT))) return false;
    if (!model) return true;
    return (await modelOf(host)) === model;
}

async function discover(model) {
    const nets = Object.values(networkInterfaces()).flat()
        .filter((n) => n && n.family === 'IPv4' && !n.internal && n.netmask === '255.255.255.0');
    for (const n of nets) {
        const base = n.address.split('.').slice(0, 3).join('.');
        const hosts = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
        const open = (await Promise.all(hosts.map(async (h) => ((await portOpen(h, SDB_PORT)) ? h : null)))).filter(Boolean);
        for (const h of open) if (await isOurTv(h, model)) return h;
    }
    return null;
}

// ---------- main

const env = readEnv();
const tizenHome = (env.TIZEN_HOME || join(homedir(), 'tizen-studio')).replace(/^~/, homedir());
const SDB = join(tizenHome, 'tools', 'sdb');
const TIZEN = join(tizenHome, 'tools', 'ide', 'bin', 'tizen');
const profile = env.TIZEN_PROFILE;
const model = env.TV_MODEL;

if (!existsSync(SDB) || !existsSync(TIZEN)) fail(`Tizen CLI not found in ${tizenHome}`, 'Set TIZEN_HOME in .env.local.');
if (!profile) fail('TIZEN_PROFILE is not set', 'Add TIZEN_PROFILE=<profile name> to .env.local.');

toolPath = [join(tizenHome, 'tools', 'ide', 'bin'), join(tizenHome, 'tools'), process.env.PATH].join(':');
// The sdb server must outlive this script's pipes, so start it detached first.
spawnSync(SDB, ['start-server'], { stdio: 'ignore', env: { ...process.env, PATH: toolPath } });

// 1. Find the TV
step('Looking for the TV');
let host = env.TV_HOST;
if (!host || !(await isOurTv(host, model))) {
    if (host) console.log(`  ${host} did not answer as ${model || 'a Tizen TV'}, scanning the network…`);
    host = await discover(model);
    if (!host) {
        fail('TV not found on the network',
            'Is the TV on, on the same network, with Developer Mode enabled (Apps → 123 → 12345 → Host PC IP = this Mac)?');
    }
    saveEnv('TV_HOST', host);
}
const serial = `${host}:${SDB_PORT}`;
const con = run(SDB, ['connect', serial]);
if (!/connected/.test(con.out)) fail(`sdb could not connect to ${serial}`, con.out.trim());
const dev = run(SDB, ['devices']).out;
if (!dev.includes(serial) || /offline|unauthorized/.test(dev.split('\n').find((l) => l.includes(serial)) || '')) {
    fail(`TV ${serial} is not ready`, dev.trim());
}
ok(`TV ${model || ''} at ${host}`);

// 2. Build
step('Building');
const build = run('sh', ['scripts/build.sh']);
if (build.code !== 0) fail('Build failed', build.out.trim());
ok('Built dist/arn0-launcher.wgt');

// 3. Sign
step(`Signing with profile ${profile}`);
const sign = run(TIZEN, ['package', '-t', 'wgt', '-s', profile, '--', WGT]);
if (!/created successfully/.test(sign.out)) fail('Signing failed', sign.out.trim());
ok('Signed');

// 4. Install
step('Installing');
const inst = run(TIZEN, ['install', '-n', WGT, '-s', serial], { timeout: 180000 });
if (!/successfully installed/.test(inst.out)) {
    const hint = /certificate|signature|author/i.test(inst.out)
        ? 'Signature mismatch: sign with the same author certificate as the installed copy, or the certificate expired.'
        : undefined;
    fail('Install failed', (hint ? hint + '\n  ' : '') + inst.out.trim().split('\n').slice(-6).join('\n  '));
}
ok('Installed');

// 5. Launch
if (!args.has('--no-run')) {
    step('Launching');
    const launch = run(TIZEN, ['run', '-p', APP_ID, '-s', serial]);
    if (!/successfully launched/.test(launch.out)) fail('Launch failed', launch.out.trim());
    ok('Running on the TV');
}

const sha = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { return '?'; } })();
const dirty = run('git', ['status', '--porcelain', '--', 'src']).out.trim() ? ' + uncommitted changes' : '';
console.log(c('32', `\nDeployed ${sha}${dirty} to ${host}`));
